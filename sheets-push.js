import { readFileSync } from 'fs';
import { google } from 'googleapis';

const DEFAULT_SPREADSHEET_ID = '1BtuWfsC-pFMX2cKdxUOuPCd1gp8XLVhnGuhgmzVXYoY';
const DEFAULT_SHEET_TAB = 'Data';

function formatGroupLabel(group) {
  const g = (group || '').trim();
  if (!g) return '';
  return /^group:/i.test(g) ? g : `Group: ${g}`;
}

function formatInterestRate(rate) {
  const s = (rate || '').replace(/\s+/g, '').trim();
  if (!s) return 'N/A';
  return s.replace(/%$/, '');
}

/**
 * Write loan rows to the spreadsheet "Data" tab (columns A–D match your sheet).
 * Requires a Google Cloud service account with Sheets API enabled, and the sheet
 * shared with the service account email as Editor.
 *
 * @param {{ group: string, interestRate: string, principalBalance: string, unpaidInterest: string }[]} loanGroups
 */
export async function pushLoanGroupsToGoogleSheet(loanGroups) {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!keyPath) {
    console.log(
      'Google Sheets: skipped (set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path).',
    );
    return false;
  }

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() || DEFAULT_SPREADSHEET_ID;
  const sheetTab = process.env.GOOGLE_SHEETS_TAB?.trim() || DEFAULT_SHEET_TAB;

  let keys;
  try {
    keys = JSON.parse(readFileSync(keyPath, 'utf8'));
  } catch (e) {
    console.error('Google Sheets: could not read credentials file:', e.message);
    return false;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: keys,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const values = loanGroups.map((r) => [
    formatGroupLabel(r.group),
    formatInterestRate(r.interestRate),
    (r.principalBalance || '').trim(),
    (r.unpaidInterest || '').trim(),
  ]);

  const dataRange = `'${sheetTab}'!A2:D2000`;

  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: dataRange,
    });
  } catch (e) {
    console.warn('Google Sheets: clear range failed (tab name wrong or no access?):', e.message);
    return false;
  }

  if (!values.length) {
    console.log('Google Sheets: cleared Data rows (no loan groups to write).');
    return true;
  }

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetTab}'!A2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    console.log(`Google Sheets: wrote ${values.length} row(s) to "${sheetTab}" (columns A–D).`);
    return true;
  } catch (e) {
    console.error('Google Sheets: update failed:', e.message);
    return false;
  }
}
