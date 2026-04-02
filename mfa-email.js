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
    /<p[^>]*\bh2\b[^>]*\btext-gray\b[^>]*>\s*(\d{6,8})\s*<\/p>/i,
    /<p[^>]*\btext-gray\b[^>]*\bh2\b[^>]*>\s*(\d{6,8})\s*<\/p>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
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
 * @param {number} [opts.maxWaitMs=120000]
 * @param {number} [opts.pollIntervalMs=4000]
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
    maxWaitMs = 120_000,
    pollIntervalMs = 4000,
  } = opts;

  const deadline = Date.now() + maxWaitMs;
  let lastErr;

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

      const uids = await client.search(
        { since: new Date(Math.max(notBefore.getTime() - 60 * 1000, Date.now() - 20 * 60 * 1000)) },
        { uid: true },
      );

      if (!Array.isArray(uids) || !uids.length) {
        await client.logout();
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      const sorted = [...uids].sort((a, b) => b - a);
      for (const uid of sorted.slice(0, 30)) {
        const msg = await client.fetchOne(
          String(uid),
          { source: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!msg?.source) continue;

        const env = msg.envelope;
        const fromAddr = env?.from?.[0]?.address ?? '';
        const subject = env?.subject ?? '';
        const internalDate = msg.internalDate ? new Date(msg.internalDate) : null;

        if (internalDate && internalDate < notBefore) continue;
        if (fromContains && !fromAddr.toLowerCase().includes(fromContains.toLowerCase())) continue;
        if (subjectContains && !subject.toLowerCase().includes(subjectContains.toLowerCase())) continue;

        const parsed = await simpleParser(msg.source);
        const htmlStr = parsed.html ? String(parsed.html) : '';
        let code = extractNelnetOtpFromHtml(htmlStr);
        if (!code) {
          const combined = [parsed.text, htmlStr.replace(/<[^>]+>/g, ' '), subject].join('\n');
          code = extractOtpFromText(combined);
        }
        if (code && code.length >= 6) {
          await client.logout();
          return code;
        }
      }

      await client.logout();
    } catch (e) {
      lastErr = e;
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw lastErr instanceof Error
    ? new Error(`Email MFA failed: ${lastErr.message}`)
    : new Error('Timed out waiting for a verification code in email');
}

export { extractOtpFromText, extractNelnetOtpFromHtml };
