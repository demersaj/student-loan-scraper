import { chromium } from 'playwright';
import { config } from 'dotenv';
import { existsSync, mkdirSync } from 'fs';
import { waitForEmailCode } from './mfa-email.js';
import { pushLoanGroupsToGoogleSheet } from './sheets-push.js';

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
 * Federal usage disclaimer (`data-cy="accept-disclaimer"`, submit) — required before My Loans / nav.
 * Uses attached + force (not only visible); main frame + iframes; avoids navigation wait on submit.
 */
async function acceptFederalDisclaimer(surface) {
  const tryClickOnSurface = async (s) => {
    const locators = [
      s.locator('[data-cy="accept-disclaimer"]'),
      s.locator('#accept-disclaimer'),
      s.locator('button[type="submit"]#accept-disclaimer'),
      s.getByRole('button', { name: /accept federal usage disclaimer/i }),
    ];
    for (const loc of locators) {
      const n = await loc.count().catch(() => 0);
      if (n === 0) continue;
      const el = loc.first();
      const connected = await el.evaluate((node) => node && node.isConnected).catch(() => false);
      if (!connected) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click(CLICK_NO_NAV).catch(() => {});
      console.log('Accepted federal usage disclaimer.');
      await surface.waitForTimeout(450);
      return true;
    }
    return false;
  };

  for (let pass = 0; pass < 22; pass++) {
    const surfaces = [surface, ...surface.frames().filter((f) => f !== surface.mainFrame())];
    for (const s of surfaces) {
      if (await tryClickOnSurface(s)) return true;
    }
    await surface.waitForTimeout(320);
  }
  return false;
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

    await acceptFederalDisclaimer(page);

    await page.waitForTimeout(350);

    const cookieStill =
      (await cookieRole.isVisible().catch(() => false)) ||
      (await cookieHeading.isVisible().catch(() => false));
    const discStill =
      (await disclaimer.isVisible().catch(() => false)) ||
      (await disclaimerByAria.isVisible().catch(() => false)) ||
      (await page.locator('[data-cy="accept-disclaimer"], #accept-disclaimer').count()) > 0;

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

/** Clicks that start OAuth/SPA transitions or submit disclaimers — avoid waiting for navigation to finish. */
const CLICK_NO_NAV = { force: true, noWaitAfter: true };

/** FSA / OIDC often label the first step "Continue" instead of Sign in. */
async function clickLoginSubmit(surface) {
  const trySurface = async (s) => {
    const primary = s
      .getByRole('button', { name: /sign in|log in|submit|continue|next|verify/i })
      .first();
    if (await primary.isVisible().catch(() => false)) {
      await primary.click(CLICK_NO_NAV);
      // Do not call textContent() after click — navigation can detach the node and hang 30s.
      console.log('Clicked login submit control');
      return true;
    }
    const submitEl = s.locator('input[type="submit"], button[type="submit"]').first();
    if (await submitEl.isVisible().catch(() => false)) {
      await submitEl.click(CLICK_NO_NAV);
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
      await fb.click(CLICK_NO_NAV);
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
    await loc.click(CLICK_NO_NAV);
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
    await el.click(CLICK_NO_NAV);
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
      await loc.click(CLICK_NO_NAV);
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
        await oneStep.click(CLICK_NO_NAV);
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

/** Open hamburger / main nav if common controls exist (mobile or collapsed nav). */
async function openMainNavIfNeeded(surface) {
  const toggles = [
    surface.getByRole('button', { name: /menu|open menu|navigation|main menu/i }).first(),
    surface.locator('[aria-label*="menu" i],[data-cy*="menu" i]').first(),
    surface.locator('mat-toolbar button').first(),
  ];
  for (const loc of toggles) {
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ force: true }).catch(() => {});
      await surface.waitForTimeout(600);
      break;
    }
  }
}

/**
 * Go to My Loans: optional MY_LOANS_URL, direct paths on current origin, then dashboard + nav + click.
 */
async function navigateToMyLoans(surface) {
  await acceptFederalDisclaimer(surface);
  await surface.waitForTimeout(400);

  const tryGoto = async (url) => {
    try {
      const resp = await surface.goto(url, { waitUntil: 'load', timeout: 45_000 });
      if (resp?.status() && resp.status() >= 400) return false;
      await surface.waitForTimeout(800);
      await acceptFederalDisclaimer(surface);
      console.log('Opened URL:', url);
      return true;
    } catch {
      return false;
    }
  };

  const envUrl = process.env.MY_LOANS_URL?.trim();
  if (envUrl && (await tryGoto(envUrl))) return true;

  let origin;
  try {
    origin = new URL(surface.url()).origin;
  } catch {
    origin = 'https://nelnet.studentaid.gov';
  }

  const loanPaths = ['/loans', '/my-loans', '/dashboard/loans', '/account/loans', '/loan/loan-groups', '/loan-groups'];
  for (const p of loanPaths) {
    if (await tryGoto(`${origin}${p}`)) return true;
  }

  await tryGoto(`${origin}/dashboard`);
  await acceptFederalDisclaimer(surface);

  await openMainNavIfNeeded(surface);
  await surface.waitForTimeout(500);

  const tryClickStrategies = async (s) => {
    await acceptFederalDisclaimer(surface);
    const nameLoose = /my\s*loans/i;
    const candidates = [
      s.getByRole('link', { name: nameLoose }).first(),
      s.getByRole('button', { name: nameLoose }).first(),
      s.getByRole('tab', { name: nameLoose }).first(),
      s.getByRole('menuitem', { name: nameLoose }).first(),
      s.getByRole('listitem').filter({ hasText: nameLoose }).first(),
      s.locator('nav a, aside a, [class*="nav"] a').filter({ hasText: nameLoose }).first(),
      s.locator('a, button').filter({ hasText: /^my\s*loans$/i }).first(),
      s.locator('a, button').filter({ hasText: nameLoose }).first(),
      s.locator('[routerlink], [ng-reflect-router-link]').filter({ hasText: nameLoose }).first(),
      s.locator('a[href*="loan" i]').filter({ hasText: nameLoose }).first(),
    ];

    for (const loc of candidates) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ force: true, noWaitAfter: true });
        console.log('Clicked My Loans (UI).');
        await s.waitForTimeout(1200);
        return true;
      }
    }

    const clicked = await s
      .evaluate(() => {
        const labels = /my\s*loans/i;
        const texts = (el) => (el.innerText || el.textContent || '').trim();
        const tryClick = (el) => {
          if (!el || typeof el.click !== 'function') return false;
          el.click();
          return true;
        };

        for (const el of document.querySelectorAll('a, button, [role="link"], [role="button"]')) {
          if (labels.test(texts(el))) return tryClick(el);
        }
        for (const el of document.querySelectorAll('[routerlink], [ng-reflect-router-link], [tabindex="0"]')) {
          if (labels.test(texts(el))) return tryClick(el);
        }
        return false;
      })
      .catch(() => false);

    if (clicked) {
      console.log('Clicked My Loans (DOM text match).');
      await acceptFederalDisclaimer(surface);
      await s.waitForTimeout(1200);
      return true;
    }

    return false;
  };

  if (await tryClickStrategies(surface)) return true;

  for (const fr of surface.frames()) {
    if (fr === surface.mainFrame()) continue;
    if (await tryClickStrategies(fr)) return true;
  }

  return false;
}

/**
 * Parse loan group rows from HTML tables or Angular Material tables (best-effort DOM scrape).
 */
async function scrapeLoanGroupsFromPage(page) {
  return page.evaluate(() => {
    /** @returns {{ group: string, interestRate: string, principalBalance: string, unpaidInterest: string }[]} */

    /** Nelnet My Loans: "<strong>Group: AC</strong>" repeated (~17 loan groups). */
    const scrapeFromGroupStrong = () => {
      const groupHeadings = [...document.querySelectorAll('strong, b')].filter((s) =>
        /^Group:\s*\S+/i.test((s.textContent || '').trim()),
      );
      if (!groupHeadings.length) return [];

      const cleanEl = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

      const parseBlob = (text) => {
        const flat = (text || '').replace(/\s+/g, ' ').trim();
        const rate =
          flat.match(/interest\s*rate[:\s]*([\d.]+\s*%)/i)?.[1]?.trim() ||
          flat.match(/([\d.]+\s*%)/)?.[1]?.trim() ||
          '';
        let principal =
          flat.match(/principal\s*balance[:\s]*(\$[\d,]+\.\d{2})/i)?.[1] ||
          flat.match(/principal[^$\d]*(\$[\d,]+\.\d{2})/i)?.[1] ||
          '';
        let unpaid =
          flat.match(/unpaid\s*accrued[^$\d]*(\$[\d,]+\.\d{2})/i)?.[1] ||
          flat.match(/accrued\s*interest[:\s]*(\$[\d,]+\.\d{2})/i)?.[1] ||
          flat.match(/unpaid\s*interest[:\s]*(\$[\d,]+\.\d{2})/i)?.[1] ||
          flat.match(/unpaid[^$\d]*(\$[\d,]+\.\d{2})/i)?.[1] ||
          '';
        const monies = [...flat.matchAll(/\$[\d,]+\.\d{2}/g)].map((x) => x[0]);
        if (!principal && monies[0]) principal = monies[0];
        if (!unpaid && monies[1]) unpaid = monies[1];
        return {
          interestRate: rate,
          principalBalance: principal,
          unpaidInterest: unpaid,
        };
      };

      /** Nelnet u-grid: per-group cells use group-* data-cy for unpaid accrued interest. */
      const readDataCyFromFragment = (frag) => {
        if (!frag) return { interestRate: '', principalBalance: '', unpaidInterest: '' };
        const pick = (...sels) => {
          for (const sel of sels) {
            const el = frag.querySelector(sel);
            if (el) return cleanEl(el);
          }
          return '';
        };
        return {
          interestRate: pick('[data-cy="interest-rate-value"]'),
          principalBalance: pick(
            '[data-cy="principal-balance-value"]',
            '[data-cy="principal-balance"]',
            '[data-cy="current-principal-value"]',
          ),
          unpaidInterest: pick(
            '[data-cy="group-unpaid-accrued-interest-value"]',
            '[data-cy="unpaid-interest-value"]',
            '[data-cy="unpaid-interest"]',
            '[data-cy="outstanding-interest-value"]',
            '[data-cy="accrued-interest-value"]',
          ),
        };
      };

      /** Last loan group: smallest wrapper that has Nelnet rate cell but no other Group: heading. */
      const fragmentForLastGroup = (strong) => {
        let el = strong.parentElement;
        for (let d = 0; d < 25 && el; d++) {
          if (!el.querySelector('[data-cy="interest-rate-value"]')) {
            el = el.parentElement;
            continue;
          }
          const otherHeadings = [...el.querySelectorAll('strong, b')].filter(
            (s) =>
              s !== strong && /^Group:\s*\S+/i.test((s.textContent || '').trim()),
          );
          if (otherHeadings.length === 0) {
            const range = document.createRange();
            range.selectNodeContents(el);
            try {
              range.setStartAfter(strong);
            } catch {
              /* strong not inside el */
            }
            const div = document.createElement('div');
            div.appendChild(range.cloneContents());
            return div;
          }
          el = el.parentElement;
        }
        return null;
      };

      const rows = [];
      for (let i = 0; i < groupHeadings.length; i++) {
        const strong = groupHeadings[i];
        const next = groupHeadings[i + 1];
        const m = (strong.textContent || '').trim().match(/^Group:\s*(.+)$/i);
        const group = m ? m[1].trim() : '';
        if (!group) continue;

        let frag = null;
        let blob = '';
        try {
          if (next) {
            const range = document.createRange();
            range.setStartAfter(strong);
            range.setEndBefore(next);
            frag = document.createElement('div');
            frag.appendChild(range.cloneContents());
            blob = frag.innerText || '';
          } else {
            frag = fragmentForLastGroup(strong);
            blob = frag ? frag.innerText : '';
            if (!blob) {
              let c = strong.parentElement;
              const label = (strong.textContent || '').trim();
              for (let d = 0; d < 20 && c; d++) {
                const t = c.innerText || '';
                if (/\$[\d,]+\.\d{2}/.test(t)) {
                  const idx = t.indexOf(label);
                  blob = idx >= 0 ? t.slice(idx + label.length) : t;
                  break;
                }
                c = c.parentElement;
              }
              if (!blob) blob = (strong.parentElement && strong.parentElement.innerText) || '';
            }
          }
        } catch {
          blob = '';
          frag = null;
        }

        const fromCy = readDataCyFromFragment(frag);
        const p = parseBlob(blob);
        rows.push({
          group,
          interestRate: fromCy.interestRate || p.interestRate,
          principalBalance: fromCy.principalBalance || p.principalBalance,
          unpaidInterest: fromCy.unpaidInterest || p.unpaidInterest,
        });
      }
      return rows;
    };

    const fromNg = scrapeFromGroupStrong();
    if (fromNg.length) return fromNg;

    const out = [];
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const mapColumns = (headerCells) => {
      const h = headerCells.map((x) => x.toLowerCase());
      const idx = (pred) => h.findIndex(pred);
      return {
        group: idx((t) => /group|account name|loan name|subsidiary|^loan$/i.test(t) && !/rate|balance|interest paid/i.test(t)),
        rate: idx((t) => /interest.*rate|^rate$|apr|fixed/i.test(t)),
        principal: idx((t) => /principal.*balance|principal$/i.test(t)),
        unpaid: idx((t) => /unpaid.*interest|outstanding.*interest|accrued/i.test(t)),
      };
    };

    const consumeTable = (headerRow, bodyRows) => {
      const headerCells = [...headerRow.querySelectorAll('th, td, mat-header-cell')].map((c) => clean(c.textContent));
      if (headerCells.length < 2) return;
      if (!headerCells.some((cell) => /principal|interest|unpaid|group|balance|rate/i.test(cell))) return;

      const col = mapColumns(headerCells);
      for (const tr of bodyRows) {
        const cells = [...tr.querySelectorAll('td, th, mat-cell')].map((c) => clean(c.textContent));
        if (cells.length < 2) continue;
        const groupText = col.group >= 0 ? cells[col.group] : cells[0];
        if (!groupText || /^total|subtotal|sum/i.test(groupText)) continue;

        out.push({
          group: groupText,
          interestRate: col.rate >= 0 ? cells[col.rate] ?? '' : '',
          principalBalance: col.principal >= 0 ? cells[col.principal] ?? '' : '',
          unpaidInterest: col.unpaid >= 0 ? cells[col.unpaid] ?? '' : '',
        });
      }
    };

    document.querySelectorAll('table').forEach((table) => {
      let headerRow = table.querySelector('thead tr');
      let bodyRows = [...table.querySelectorAll('tbody tr')];
      if (!headerRow && bodyRows.length > 0) {
        headerRow = bodyRows[0];
        bodyRows = bodyRows.slice(1);
      }
      if (headerRow && bodyRows.length) consumeTable(headerRow, bodyRows);
    });

    document.querySelectorAll('mat-table, table.mat-table, table.mat-mdc-table').forEach((table) => {
      const hRow = table.querySelector('mat-header-row, tr[mat-header-row]');
      const bRows = [...table.querySelectorAll('mat-row, tr[mat-row]')];
      if (hRow && bRows.length) consumeTable(hRow, bRows);
    });

    return out;
  });
}

/** Parse "$39,036.30" / "39,036.30" to a number (USD). */
function parseCurrencyToNumber(text) {
  if (text == null || typeof text !== 'string') return NaN;
  const m = String(text)
    .replace(/,/g, '')
    .match(/-?\$?\s*([\d.]+)/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : NaN;
}

/** Total owed ≈ sum of principal + unpaid interest per loan group (matches Nelnet “current balance”). */
function sumLoanGroupTotalsUsd(loanGroups) {
  let sum = 0;
  for (const r of loanGroups) {
    const p = parseCurrencyToNumber(r.principalBalance);
    const u = parseCurrencyToNumber(r.unpaidInterest);
    sum += (Number.isFinite(p) ? p : 0) + (Number.isFinite(u) ? u : 0);
  }
  return sum;
}

async function scrapeCurrentBalanceText(surface) {
  await surface
    .locator('[data-cy="current-balance-value"]')
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 })
    .catch(() => {});

  const read = (loc) =>
    loc.evaluate(() => {
      const el = document.querySelector('[data-cy="current-balance-value"]');
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    });
  let t = await read(surface);
  if (!t) {
    for (const fr of surface.frames()) {
      if (fr === surface.mainFrame()) continue;
      t = await read(fr).catch(() => '');
      if (t) break;
    }
  }
  return t;
}

/**
 * Compare scraped group totals to the page’s current balance (authoritative).
 * @returns {{ ok: boolean, currentText: string, current: number, sum: number, diff: number }}
 */
async function validateLoanTotalsAgainstCurrentBalance(surface, loanGroups) {
  const currentText = await scrapeCurrentBalanceText(surface);
  const current = parseCurrencyToNumber(currentText);
  const sum = sumLoanGroupTotalsUsd(loanGroups);
  const diff = Math.abs(sum - current);
  const tolerance = 1.02;
  const ok =
    Number.isFinite(current) &&
    Number.isFinite(sum) &&
    diff <= tolerance;
  return { ok, currentText, current, sum, diff };
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
    // OAuth/Angular often updates the shell without a classic document load — wait for MFA or next paint.
    await Promise.race([
      activePage.waitForLoadState('load', { timeout: 60_000 }),
      activePage
        .getByText(
          /receive your authentication code|how do you want|verification|one-time|security code|two.factor|mfa/i,
        )
        .first()
        .waitFor({ state: 'visible', timeout: 45_000 }),
      activePage.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]').first().waitFor({
        state: 'visible',
        timeout: 45_000,
      }),
    ]).catch(() => {});
    await activePage.waitForTimeout(600);
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
        const imapMax = Number(process.env.MFA_IMAP_MAX_WAIT_MS);
        const code = await waitForEmailCode({
          host: MFA_IMAP_HOST,
          port: MFA_IMAP_PORT,
          user: MFA_IMAP_USER,
          password: MFA_IMAP_PASSWORD,
          mailbox: MFA_IMAP_MAILBOX,
          notBefore,
          maxWaitMs: Number.isFinite(imapMax) && imapMax > 0 ? imapMax : undefined,
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

    console.log('Opening My Loans...');
    await activePage.waitForLoadState('load').catch(() => {});
    await activePage.waitForTimeout(1500);
    await acceptFederalDisclaimer(activePage);
    await screenshot(activePage, '06-dashboard');

    const onMyLoans = await navigateToMyLoans(activePage);
    if (!onMyLoans) {
      console.warn(
        'Could not open My Loans (URL, click, or DOM). Set MY_LOANS_URL in .env to the exact page from the address bar.',
      );
    }
    await activePage.waitForLoadState('load').catch(() => {});
    await activePage.waitForTimeout(2500);
    await screenshot(activePage, '07-my-loans');

    await activePage.getByText(/Group:\s*\S+/i).first().waitFor({ state: 'attached', timeout: 25_000 }).catch(() => {});

    const scrollMyLoansForVirtualization = async () => {
      for (let s = 0; s < 10; s++) {
        await activePage.evaluate(() => window.scrollBy(0, 700));
        await activePage.waitForTimeout(200);
      }
      await activePage.evaluate(() => window.scrollTo(0, 0));
      await activePage.waitForTimeout(400);
    };

    await scrollMyLoansForVirtualization();

    let loanGroups = await scrapeLoanGroupsFromPage(activePage);
    if (!loanGroups.length) {
      for (const fr of activePage.frames()) {
        if (fr === activePage.mainFrame()) continue;
        loanGroups = await scrapeLoanGroupsFromPage(fr);
        if (loanGroups.length) break;
      }
    }

    if (loanGroups.length) {
      let check = await validateLoanTotalsAgainstCurrentBalance(activePage, loanGroups);
      if (!check.ok && Number.isFinite(check.current)) {
        console.warn(
          `Balance check: Σ(principal+unpaid) $${check.sum.toFixed(2)} vs current balance $${check.current.toFixed(2)} (diff $${check.diff.toFixed(2)}). Re-scrolling and re-scraping once…`,
        );
        await scrollMyLoansForVirtualization();
        loanGroups = await scrapeLoanGroupsFromPage(activePage);
        if (!loanGroups.length) {
          for (const fr of activePage.frames()) {
            if (fr === activePage.mainFrame()) continue;
            loanGroups = await scrapeLoanGroupsFromPage(fr);
            if (loanGroups.length) break;
          }
        }
        check = await validateLoanTotalsAgainstCurrentBalance(activePage, loanGroups);
      }
      if (Number.isFinite(check.current)) {
        if (check.ok) {
          console.log(
            `Balance check OK: Σ(principal+unpaid) $${check.sum.toFixed(2)} ≈ current balance $${check.current.toFixed(2)}.`,
          );
        } else {
          console.warn(
            `Balance check still off: Σ $${check.sum.toFixed(2)} vs [data-cy=current-balance-value] $${check.current.toFixed(2)} (diff $${check.diff.toFixed(2)}). Compare row amounts to the page.`,
          );
        }
      } else if (check.currentText) {
        console.warn('Could not parse current balance from:', check.currentText);
      } else {
        console.warn('No [data-cy="current-balance-value"] found; skipped total-vs-page check.');
      }
    }

    if (!loanGroups.length) {
      console.log('\nNo loan table rows parsed. Dollar amounts on page (fallback):');
      const amounts = await activePage.locator('text=/\\$[\\d,]+\\.\\d{2}/').allTextContents();
      amounts.forEach((a) => console.log(' ', a.trim()));
      console.log('Inspect screenshots/07-my-loans.png and we can tighten selectors.');
    } else {
      if (loanGroups.length !== 17) {
        console.warn(
          `Parsed ${loanGroups.length} loan group(s). If you expect 17, scroll the My Loans page manually once and compare — some UIs virtualize lists.`,
        );
      }
      console.log('\n--- Loan groups ---');
      for (const row of loanGroups) {
        console.log(
          `• ${row.group}\n  Interest rate: ${row.interestRate || '—'}\n  Principal balance: ${row.principalBalance || '—'}\n  Unpaid interest: ${row.unpaidInterest || '—'}`,
        );
      }
      console.log('\nJSON:\n' + JSON.stringify(loanGroups, null, 2));

      await pushLoanGroupsToGoogleSheet(loanGroups);
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
