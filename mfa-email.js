import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/** Pull 6–8 digit codes and common formatted variants from mail text. */
function extractOtpFromText(text) {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ');
  const patterns = [
    /\b(\d{6,8})\b/,
    /\b(\d{3}-\d{3})\b/,
    /\b(\d{4}-\d{4})\b/,
    /(?:code|password)[:\s]+(\d{6,8})/i,
    /(?:code|password)[:\s]+(\d{3}-\d{3})/i,
  ];
  for (const re of patterns) {
    const m = flat.match(re);
    if (!m) continue;
    return m[1].replace(/\D/g, '');
  }
  return null;
}

/**
 * Nelnet / NelnetNoReply template: <p class="h2 text-gray text-center ...">807166</p>
 */
function extractNelnetOtpFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const patterns = [
    /<p[^>]*\bh2\b[^>]*\btext-gray\b[^>]*>[\s\S]*?(\d{6,8})[\s\S]*?<\/p>/i,
    /<p[^>]*\btext-gray\b[^>]*\bh2\b[^>]*>[\s\S]*?(\d{6,8})[\s\S]*?<\/p>/i,
    /<p[^>]*class="[^"]*\bh2\b[^"]*\btext-gray\b[^"]*"[^>]*>[\s\S]*?(\d{6,8})/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function senderBlob(envelope) {
  const f = envelope?.from?.[0];
  return [f?.address, f?.name].filter(Boolean).join(' ').toLowerCase();
}

function fromMatches(envelope, needle) {
  if (!needle?.trim()) return true;
  return senderBlob(envelope).includes(needle.toLowerCase().trim());
}

/**
 * Poll IMAP for a recent message and extract an OTP. Use an app-specific password,
 * not your main account password (Gmail: Google Account → Security → App passwords).
 *
 * @param {object} opts
 * @param {string} opts.host - e.g. imap.gmail.com, outlook.office365.com
 * @param {number} [opts.port=993]
 * @param {string} opts.user
 * @param {string} opts.password
 * @param {string} [opts.mailbox=INBOX]
 * @param {Date} [opts.notBefore] - ignore messages strictly older than this (received time)
 * @param {string} [opts.fromContains] - sender substring filter, e.g. studentaid.gov
 * @param {string} [opts.subjectContains] - subject substring filter, e.g. security
 * @param {number} [opts.maxWaitMs=180000]
 * @param {number} [opts.pollIntervalMs=4000]
 * @param {boolean} [opts.debug] - log skip reasons to stderr
 */
export async function waitForEmailCode(opts) {
  const {
    host,
    port = 993,
    user,
    password,
    mailbox = 'INBOX',
    notBefore = new Date(Date.now() - 3 * 60 * 1000),
    fromContains,
    subjectContains,
    maxWaitMs = 180_000,
    pollIntervalMs = 4000,
    debug = process.env.MFA_IMAP_DEBUG === '1' || process.env.MFA_IMAP_DEBUG === 'true',
  } = opts;

  /** Allow server/local clock skew so we don’t drop the mail that just arrived. */
  const cutoff = new Date(notBefore.getTime() - 3 * 60 * 1000);

  const deadline = Date.now() + maxWaitMs;
  let lastErr;
  const dbg = (...args) => {
    if (debug) console.error('[mfa-imap]', ...args);
  };

  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass: password },
      logger: false,
    });

    try {
      await client.connect();
      await client.mailboxOpen(mailbox);

      const uidSet = new Set();
      const addUids = (arr) => {
        if (Array.isArray(arr)) for (const u of arr) uidSet.add(u);
      };

      addUids(await client.search({ unseen: true }, { uid: true }).catch(() => []));
      const sinceWide = new Date(Math.max(cutoff.getTime() - 24 * 60 * 60 * 1000, Date.now() - 7 * 24 * 60 * 60 * 1000));
      addUids(await client.search({ since: sinceWide }, { uid: true }).catch(() => []));
      if (uidSet.size < 10) {
        addUids(await client.search({ since: new Date(Date.now() - 24 * 60 * 60 * 1000) }, { uid: true }).catch(() => []));
      }

      const sorted = [...uidSet].sort((a, b) => b - a).slice(0, 60);
      if (!sorted.length) {
        dbg('no UIDs from IMAP search (unseen/since); mailbox', mailbox);
        await client.logout();
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      for (const uid of sorted) {
        const msg = await client.fetchOne(
          String(uid),
          { source: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!msg?.source) continue;

        const env = msg.envelope;
        const subject = env?.subject ?? '';
        const internalDate = msg.internalDate ? new Date(msg.internalDate) : null;

        if (internalDate && internalDate < cutoff) {
          dbg('skip uid', uid, 'internalDate', internalDate.toISOString(), '< cutoff', cutoff.toISOString());
          continue;
        }
        if (!fromMatches(env, fromContains)) {
          dbg('skip uid', uid, 'from', senderBlob(env), 'wanted', fromContains);
          continue;
        }
        if (subjectContains && !subject.toLowerCase().includes(subjectContains.toLowerCase())) {
          dbg('skip uid', uid, 'subject', subject);
          continue;
        }

        const parsed = await simpleParser(msg.source);
        const htmlStr = parsed.html != null ? String(parsed.html) : '';
        let code = extractNelnetOtpFromHtml(htmlStr);
        if (!code) {
          const combined = [parsed.text, htmlStr.replace(/<[^>]+>/g, ' '), subject].join('\n');
          code = extractOtpFromText(combined);
        }
        if (code && code.length >= 6) {
          await client.logout();
          return code;
        }
        dbg('skip uid', uid, 'no code in body; from', senderBlob(env));
      }

      await client.logout();
    } catch (e) {
      lastErr = e;
      dbg('IMAP error', e.message);
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const hint =
    ' Try MFA_IMAP_DEBUG=1 (see stderr), MFA_IMAP_MAX_WAIT_MS=300000, clear MFA_EMAIL_SUBJECT_CONTAINS if set, ' +
    'set MFA_EMAIL_FROM_CONTAINS to a substring of the real From line, or use MFA_IMAP_MAILBOX for the folder that receives the code.';

  throw lastErr instanceof Error
    ? new Error(`Email MFA failed: ${lastErr.message}.${hint}`)
    : new Error(`Timed out waiting for a verification code in email.${hint}`);
}

export { extractOtpFromText, extractNelnetOtpFromHtml };
