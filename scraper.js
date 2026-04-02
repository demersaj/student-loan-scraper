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
      // Do not call textContent() after click — navigation can detach the node and hang 30s.
      console.log('Clicked login submit control');
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

  const tryFallback = async (s) => {
    const fb = s.getByRole('button', { name: /continue|sign in|log in|submit|next|verify/i }).first();
    if (await fb.isVisible().catch(() => false)) {
      await fb.click({ force: true });
      console.log('Clicked login (fallback button).');
      return true;
    }
    return false;
  };

  if (await tryFallback(surface)) return;
  for (const frame of surface.frames()) {
    if (frame === surface.mainFrame()) continue;
    if (await tryFallback(frame)) return;
  }

  throw new Error(
    'No login submit button found (sign in / continue / verify). Check screenshots and update selectors.',
  );
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
 * Nelnet: "How Do You Want to Receive Your Authentication Code?" — Text vs
 * "Email code to a***@…" radios + green "Send Code". Material radios often need
 * mat-radio or label clicks, not only getByRole('radio').
 */
async function pickEmailMfaOption(s, surface) {
  await s
    .getByText(/receive your authentication code|authentication code\?/i)
    .first()
    .waitFor({ state: 'visible', timeout: 12_000 })
    .catch(() => {});

  const tryClick = async (loc, label) => {
    if (!(await loc.isVisible().catch(() => false))) return false;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ force: true });
    console.log(`MFA: ${label}`);
    await surface.waitForTimeout(450);
    return true;
  };

  /** Nelnet `u-radio__input` is often not “visible” to Playwright but still clickable. */
  const tryForceClickIfPresent = async (loc, label) => {
    if ((await loc.count()) === 0) return false;
    const el = loc.first();
    const attached = await el.evaluate((node) => node.isConnected).catch(() => false);
    if (!attached) return false;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true });
    console.log(`MFA: ${label}`);
    await surface.waitForTimeout(450);
    return true;
  };

  // Prefer the visible label (u-radio); works when the real <input> is hidden. Try even in iframes
  // where the heading text may live on the parent — id=for is unique on this step.
  if (await tryClick(s.locator('label[for="mfa-option-1"]').first(), 'selected Email (label[for=mfa-option-1])')) {
    return true;
  }
  if (
    await tryForceClickIfPresent(
      s.locator('input[type="radio"]#mfa-option-1'),
      'selected Email (input#mfa-option-1)',
    )
  ) {
    return true;
  }

  // Native radio — id / data-cy / name+value (may be visibility:hidden for styling).
  if (await tryForceClickIfPresent(
    s.locator('input[type="radio"][name="AuthChoice"][value="Email"]'),
    'selected Email (AuthChoice=Email)',
  )) {
    return true;
  }
  if (await tryForceClickIfPresent(s.locator('input[type="radio"][data-cy="mfa-radio-1"]'), 'selected Email (data-cy mfa-radio-1)')) {
    return true;
  }

  if (await tryClick(s.getByRole('radio', { name: /email code to|email.*@/i }).first(), 'selected Email (radio)')) {
    return true;
  }
  if (await tryClick(s.getByRole('radio', { name: /email/i }).first(), 'selected Email (radio, broad)')) {
    return true;
  }

  const matEmail = s.locator('mat-radio-button, .mat-mdc-radio-button').filter({ hasText: /email code to|email.*@/i }).first();
  if (await tryClick(matEmail, 'selected Email (mat-radio-button)')) {
    return true;
  }

  if (await tryClick(s.getByText(/email code to/i).first(), 'selected Email (visible text)')) {
    return true;
  }
  if (await tryClick(s.locator('label').filter({ hasText: /email code to/i }).first(), 'selected Email (label)')) {
    return true;
  }

  const authHeading = s.getByText(/receive your authentication code/i).first();
  const onChooser = await authHeading.isVisible().catch(() => false);
  if (onChooser) {
    const authRadios = s.locator('input[type="radio"][name="AuthChoice"]');
    const cnt = await authRadios.count();
    if (cnt >= 2) {
      if (await tryForceClickIfPresent(authRadios.nth(1), 'selected 2nd AuthChoice (Email)')) {
        return true;
      }
    }
    const radios = s.getByRole('radio');
    if ((await radios.count()) === 2) {
      if (await tryClick(radios.nth(1), 'selected second role=radio (Email)')) {
        return true;
      }
    }
  }

  return false;
}

async function clickSendMfaCodeButton(s, surface) {
  const candidates = [
    s.getByRole('button', { name: /^send code$/i }).first(),
    s.getByRole('button', { name: /send\s+code|resend(\s+code)?|send\s+verification/i }).first(),
    s.locator('button[u-button], button.u-button--contained').filter({ hasText: /send\s+code/i }).first(),
    s.locator('button.mat-mdc-raised-button, button.mdc-button').filter({ hasText: /send\s+code/i }).first(),
    s.locator('button[type="submit"]').filter({ hasText: /send/i }).first(),
    s.locator('button, a').filter({ hasText: /^send code$/i }).first(),
    s.getByRole('link', { name: /send\s+code/i }).first(),
  ];

  for (const loc of candidates) {
    if (await loc.isVisible().catch(() => false)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ force: true });
      console.log('MFA: clicked Send Code.');
      await surface.waitForTimeout(900);
      return true;
    }
  }
  return false;
}

/**
 * Federal login often asks you to pick Email vs text, then click Send code before the mail arrives.
 * Returns true if we likely clicked something on an MFA chooser / send step.
 */
async function prepareEmailMfaFlow(surface) {
  const surfaces = [surface, ...surface.frames().filter((f) => f !== surface.mainFrame())];

  let picked = false;
  for (const s of surfaces) {
    if (await pickEmailMfaOption(s, surface)) {
      picked = true;
      break;
    }
  }

  await surface.waitForTimeout(picked ? 700 : 0);

  let sent = false;
  for (const s of surfaces) {
    if (await clickSendMfaCodeButton(s, surface)) {
      sent = true;
      break;
    }
  }

  if (picked && !sent) {
    await surface.waitForTimeout(1500);
    for (const s of surfaces) {
      if (await clickSendMfaCodeButton(s, surface)) {
        sent = true;
        break;
      }
    }
  }

  if (!picked && !sent) {
    for (const s of surfaces) {
      const oneStep = s
        .getByRole('button', { name: /email.*code|code.*email|send.*to.*email|verify.*email/i })
        .first();
      if (await oneStep.isVisible().catch(() => false)) {
        await oneStep.click({ force: true });
        console.log('MFA: clicked combined email/send control.');
        await surface.waitForTimeout(1200);
        return true;
      }
    }
  }

  return picked || sent;
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
    const mfaNelnetHeading = activePage
      .getByText(/how do you want to receive your authentication code/i)
      .first();
    const otpGuess = otpLocator(activePage);
    const hasMfa =
      (await mfaPrompt.isVisible().catch(() => false)) ||
      (await mfaChooser.isVisible().catch(() => false)) ||
      (await mfaNelnetHeading.isVisible().catch(() => false)) ||
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
          // Nelnet MFA comes from NelnetNoReply / *@*nelnet* unless you set MFA_EMAIL_FROM_CONTAINS.
          fromContains: MFA_EMAIL_FROM_CONTAINS?.trim()
            ? MFA_EMAIL_FROM_CONTAINS
            : 'nelnet',
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
