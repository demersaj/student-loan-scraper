import { chromium } from 'playwright';
import { config } from 'dotenv';
import { existsSync, mkdirSync } from 'fs';
import { waitForEmailCode } from './mfa-email.js';

config();

const USERNAME = process.env.NELNET_USERNAME;
const PASSWORD = process.env.NELNET_PASSWORD;

/** Optional: IMAP app password–based email MFA (see script header / mfa-email.js). */
const MFA_IMAP_HOST = process.env.MFA_IMAP_HOST;
const MFA_IMAP_PORT = process.env.MFA_IMAP_PORT ? Number(process.env.MFA_IMAP_PORT) : 993;
const MFA_IMAP_USER = process.env.MFA_IMAP_USER;
const MFA_IMAP_PASSWORD = process.env.MFA_IMAP_PASSWORD;
const MFA_IMAP_MAILBOX = process.env.MFA_IMAP_MAILBOX || 'INBOX';
const MFA_EMAIL_FROM_CONTAINS = process.env.MFA_EMAIL_FROM_CONTAINS;
const MFA_EMAIL_SUBJECT_CONTAINS = process.env.MFA_EMAIL_SUBJECT_CONTAINS;

if (!USERNAME || !PASSWORD) {
  console.error('Missing credentials. Copy .env.example to .env and fill in your username and password.');
  process.exit(1);
}

if (!existsSync('./screenshots')) mkdirSync('./screenshots');

async function screenshot(page, name) {
  await page.screenshot({ path: `./screenshots/${name}.png` });
}

/**
 * Cookie banner sits above the federal disclaimer; clear cookie first, then disclaimer.
 */
async function dismissBlockingOverlays(page) {
  const cookieHeading = page.getByText(/this site uses cookies/i).first();
  const disclaimer = page.locator('[data-cy="accept-disclaimer"], #accept-disclaimer').first();
  const disclaimerByAria = page.getByRole('button', {
    name: /accept federal usage disclaimer/i,
  });

  for (let pass = 0; pass < 10; pass++) {
    // Cookie layer is often on top — remove it before disclaimer clicks reliably work.
    const cookieRole = page.getByRole('button', { name: /accept all/i }).first();
    const cookieText = page.locator('button, a[role="button"]').filter({ hasText: /^accept all$/i }).first();
    if (await cookieRole.isVisible().catch(() => false)) {
      await cookieRole.click({ force: true }).catch(() => {});
      console.log('Clicked cookie Accept all (role).');
    } else if (await cookieText.isVisible().catch(() => false)) {
      await cookieText.click({ force: true }).catch(() => {});
      console.log('Clicked cookie Accept all (text).');
    }

    if (await disclaimer.isVisible().catch(() => false)) {
      await disclaimer.scrollIntoViewIfNeeded().catch(() => {});
      await disclaimer.click({ force: true }).catch(() => {});
      console.log('Clicked federal disclaimer Accept.');
    } else if (await disclaimerByAria.isVisible().catch(() => false)) {
      await disclaimerByAria.click({ force: true }).catch(() => {});
      console.log('Clicked federal disclaimer (aria).');
    } else {
      const acceptOnly = page.getByRole('button', { name: /^accept$/i });
      if ((await acceptOnly.count()) > 0 && (await acceptOnly.first().isVisible().catch(() => false))) {
        await acceptOnly.first().click({ force: true }).catch(() => {});
        console.log('Clicked plain Accept.');
      }
    }

    await page.waitForTimeout(350);

    const cookieStill =
      (await cookieRole.isVisible().catch(() => false)) ||
      (await cookieHeading.isVisible().catch(() => false));
    const discStill =
      (await disclaimer.isVisible().catch(() => false)) ||
      (await disclaimerByAria.isVisible().catch(() => false));

    if (!cookieStill && !discStill && pass >= 2) break;
  }
}

/** Page where login actually happens (main tab or popup from Log In). */
async function getLoginPageAfterClick(mainPage, triggerClick) {
  const context = mainPage.context();
  // Short wait: same-tab login should not block on waitForEvent('page').
  const popupPromise = context.waitForEvent('page', { timeout: 8_000 }).catch(() => null);
  await triggerClick();
  const popup = await popupPromise;
  const loginPage = popup || mainPage;
  await loginPage.waitForLoadState('load').catch(() => {});
  try {
    await loginPage.waitForLoadState('domcontentloaded', { timeout: 15_000 });
  } catch {
    /* continue */
  }
  return loginPage;
}

/** FSA / OIDC often use placeholder or aria without <label for=…>. */
function userIdLocator(surface) {
  return surface
    .getByLabel(/username|email|fsa id|user id|account|sign in with/i)
    .or(surface.getByPlaceholder(/username|email|fsa id|user id|account/i))
    .or(surface.locator('input[type="email"]'))
    .or(surface.locator('input[name*="user" i], input[id*="user" i], input[name*="identifier" i]'))
    .first();
}

function passwordLocator(surface) {
  return surface
    .getByLabel(/password/i)
    .or(surface.getByPlaceholder(/password/i))
    .or(surface.locator('input[type="password"]'))
    .first();
}

async function fillCredentials(surface, username, password) {
  console.log('Entering credentials...');
  const trySurface = async (s) => {
    const u = userIdLocator(s);
    await u.waitFor({ state: 'visible', timeout: 55_000 });
    await u.fill(username);
    const p = passwordLocator(s);
    await p.waitFor({ state: 'visible', timeout: 20_000 });
    await p.fill(password);
  };

  try {
    await trySurface(surface);
  } catch {
    const childFrames = surface.frames().filter((f) => f !== surface.mainFrame());
    let lastErr;
    for (const frame of childFrames) {
      try {
        await trySurface(frame);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('Login fields not found on page or in iframes');
  }
}

/** FSA / OIDC often label the first step "Continue" instead of Sign in. */
async function clickLoginSubmit(surface) {
  const trySurface = async (s) => {
    const primary = s
      .getByRole('button', { name: /sign in|log in|submit|continue|next|verify/i })
      .first();
    if (await primary.isVisible().catch(() => false)) {
      await primary.click({ force: true });
      console.log('Clicked login submit:', (await primary.textContent())?.trim());
      return true;
    }
    const submitEl = s.locator('input[type="submit"], button[type="submit"]').first();
    if (await submitEl.isVisible().catch(() => false)) {
      await submitEl.click({ force: true });
      console.log('Clicked submit control (type=submit).');
      return true;
    }
    return false;
  };

  if (await trySurface(surface)) return;

  for (const frame of surface.frames()) {
    if (frame === surface.mainFrame()) continue;
    if (await trySurface(frame)) return;
  }

  const fallback = surface.getByRole('button', { name: /continue|sign in|next/i }).first();
  await fallback.waitFor({ state: 'visible', timeout: 15_000 });
  await fallback.click({ force: true });
}

function otpLocator(surface) {
  return surface
    .getByLabel(/code|verification|one-time|authenticat|security code/i)
    .or(surface.getByPlaceholder(/code|verification|enter code/i))
    .or(surface.locator('input[autocomplete="one-time-code"]'))
    .or(surface.locator('input[inputmode="numeric"]'))
    .first();
}

async function fillOtpAndSubmit(surface, code) {
  const trySurface = async (s) => {
    const o = otpLocator(s);
    await o.waitFor({ state: 'visible', timeout: 30_000 });
    await o.fill(code);
  };

  try {
    await trySurface(surface);
  } catch (err) {
    let lastErr = err;
    for (const frame of surface.frames()) {
      if (frame === surface.mainFrame()) continue;
      try {
        await trySurface(frame);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
  }

  await clickLoginSubmit(surface);
}

/**
 * Federal login often asks you to pick Email vs text, then click Send code before the mail arrives.
 * Returns true if we likely clicked something on an MFA chooser / send step.
 */
async function prepareEmailMfaFlow(surface) {
  const sendName =
    /send(\s+(a\s+)?code)?|resend|get\s+(the\s+)?code|email\s+(me\s+)?(a\s+)?code|request\s+.*code|send\s+verification|text\s+me|verify\s+by\s+email/i;

  const trySurface = async (s) => {
    let acted = false;

    const oneStepEmail = s
      .getByRole('button', { name: /email.*code|code.*email|send.*to.*(your\s+)?email|verify.*email/i })
      .first();
    if (await oneStepEmail.isVisible().catch(() => false)) {
      await oneStepEmail.click({ force: true });
      console.log('MFA: clicked combined email / send control.');
      await surface.waitForTimeout(1200);
      return true;
    }

    const emailPickers = [
      s.getByRole('radio', { name: /email/i }).first(),
      s.getByRole('tab', { name: /email/i }).first(),
      s.getByRole('button', { name: /^email$/i }).first(),
      s.getByRole('menuitemradio', { name: /email/i }).first(),
      s.locator('[role="option"]').filter({ hasText: /^email$/i }).first(),
    ];

    for (const loc of emailPickers) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ force: true });
        console.log('MFA: selected Email as delivery method.');
        acted = true;
        await surface.waitForTimeout(500);
        break;
      }
    }

    const senders = [
      s.getByRole('button', { name: sendName }).first(),
      s.getByRole('link', { name: sendName }).first(),
      s.locator('button, a').filter({ hasText: sendName }).first(),
    ];

    for (const loc of senders) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ force: true });
        const txt = (await loc.textContent())?.trim();
        console.log('MFA: clicked send/request:', txt || '(control)');
        acted = true;
        await surface.waitForTimeout(1200);
        break;
      }
    }

    return acted;
  };

  if (await trySurface(surface)) return true;
  for (const frame of surface.frames()) {
    if (frame === surface.mainFrame()) continue;
    if (await trySurface(frame)) return true;
  }
  return false;
}

function imapMfaConfigured() {
  return Boolean(MFA_IMAP_HOST && MFA_IMAP_USER && MFA_IMAP_PASSWORD);
}

async function scrapeNelnet() {
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const page = await browser.newPage();
  /** Tab that actually shows the post-click login UI (may equal page or a popup). */
  let activePage = page;

  try {
    console.log('Navigating to Nelnet...');
    // Avoid networkidle: federal/loan sites keep long-lived connections (analytics, etc.),
    // so networkidle often never fires and times out.
    await page.goto('https://nelnet.studentaid.gov/welcome', {
      waitUntil: 'load',
      timeout: 60_000,
    });

    // Angular draws overlays after load; give the app a tick before dismissing.
    await page.waitForTimeout(1500);
    await dismissBlockingOverlays(page);
    await screenshot(page, '01-landing');

    // Landing uses a button "Log In | Create Online Account", not a link.
    await dismissBlockingOverlays(page);
    console.log('Looking for log in...');
    const logIn = page
      .getByRole('button', { name: /log in/i })
      .or(page.getByRole('link', { name: /sign in|log in|login/i }))
      .first();
    await logIn.waitFor({ state: 'visible', timeout: 20_000 });

    activePage = await getLoginPageAfterClick(page, async () => {
      await logIn.click({ force: true });
    });
    await dismissBlockingOverlays(activePage);
    await screenshot(activePage, '02-login-page');

    await fillCredentials(activePage, USERNAME, PASSWORD);
    await screenshot(activePage, '03-credentials-filled');

    console.log('Submitting login...');
    await clickLoginSubmit(activePage);
    await activePage.waitForLoadState('load', { timeout: 60_000 });
    await screenshot(activePage, '04-post-login');

    // Email / MFA OTP step (may show method picker + Send code before the input appears)
    const mfaPrompt = activePage
      .getByText(/verification|two.factor|mfa|code sent|security code|one-time code/i)
      .first();
    const mfaChooser = activePage
      .getByText(/choose how|how would you like|verify it|select.*delivery|two-step|second.*factor|authentication method/i)
      .first();
    const otpGuess = otpLocator(activePage);
    const hasMfa =
      (await mfaPrompt.isVisible().catch(() => false)) ||
      (await mfaChooser.isVisible().catch(() => false)) ||
      (await otpGuess.isVisible().catch(() => false));
    if (hasMfa) {
      const prepared = await prepareEmailMfaFlow(activePage);
      if (prepared) console.log('MFA: waiting for email to be delivered...');
      await activePage.waitForTimeout(prepared ? 1500 : 500);

      // Timestamp after triggering send so IMAP ignores older unrelated messages
      const notBefore = prepared ? new Date() : new Date(Date.now() - 2 * 60 * 1000);

      if (imapMfaConfigured()) {
        console.log('\nEmail MFA: polling inbox via IMAP...');
        await activePage.waitForTimeout(prepared ? 1000 : 2500);
        const code = await waitForEmailCode({
          host: MFA_IMAP_HOST,
          port: MFA_IMAP_PORT,
          user: MFA_IMAP_USER,
          password: MFA_IMAP_PASSWORD,
          mailbox: MFA_IMAP_MAILBOX,
          notBefore,
          fromContains: MFA_EMAIL_FROM_CONTAINS || undefined,
          subjectContains: MFA_EMAIL_SUBJECT_CONTAINS || undefined,
        });
        console.log('Entering code from email and submitting...');
        await fillOtpAndSubmit(activePage, code);
        await activePage.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
      } else {
        console.log(
          '\nMFA required. To auto-read email, set MFA_IMAP_HOST, MFA_IMAP_USER, MFA_IMAP_PASSWORD (app password).',
        );
        console.log('Otherwise enter the code in the browser, then press Enter here...');
        await new Promise((resolve) => process.stdin.once('data', resolve));
        await activePage.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
      }
      await screenshot(activePage, '05-post-mfa');
    }

    // Scrape balance
    console.log('Looking for loan balance...');
    await screenshot(activePage, '06-dashboard');

    // Try common balance selectors — Nelnet may use any of these
    const balanceSelectors = [
      '[data-testid*="balance"]',
      '[class*="balance"]',
      '[class*="total"]',
      'text=/outstanding balance/i',
      'text=/current balance/i',
      'text=/total balance/i',
      'text=/amount due/i',
    ];

    let balanceText = null;
    for (const selector of balanceSelectors) {
      const el = activePage.locator(selector).first();
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        balanceText = await el.textContent();
        console.log(`Found balance via selector "${selector}": ${balanceText?.trim()}`);
        break;
      }
    }

    if (!balanceText) {
      // Fallback: dump all dollar amounts found on the page
      console.log('\nCould not find a labelled balance element. Dollar amounts found on page:');
      const amounts = await activePage.locator('text=/\\$[\\d,]+\\.\\d{2}/').allTextContents();
      amounts.forEach(a => console.log(' ', a.trim()));
      console.log('\nCheck screenshots/ to see the dashboard and identify the right element.');
    } else {
      console.log('\n--- Nelnet Balance ---');
      console.log(balanceText.trim());
    }

  } catch (err) {
    console.error('Scraper error:', err.message);
    await screenshot(activePage, 'error');
    console.log('Screenshot saved to screenshots/error.png');
  } finally {
    console.log('\nDone. Press Enter to close the browser...');
    await new Promise(resolve => process.stdin.once('data', resolve));
    await browser.close();
    process.stdin.destroy();
  }
}

scrapeNelnet();
