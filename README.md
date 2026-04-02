# Nelnet scraper

Personal automation that signs into [Nelnet](https://nelnet.studentaid.gov/) (StudentAid.gov), opens **My Loans**, scrapes each loan group’s **interest rate**, **principal balance**, and **unpaid accrued interest**, prints them to the console, optionally pushes rows to **Google Sheets**, and validates totals against the page’s **current balance**.

This project is not affiliated with or endorsed by Nelnet or the U.S. Department of Education. Use only on your own account and in line with applicable terms of service.

## Requirements

- **Node.js** 18+ (recommended)
- **Chromium** via Playwright (installed by the command below)

## Setup

```bash
cd nelnet-scraper
npm install
npm run install-browsers
cp .env.example .env
```

Edit `.env` with your credentials and optional settings (see below).

## Run

```bash
npm start
```

A **headed** Chromium window opens (`headless: false` in code). After MFA, the script navigates to My Loans, scrolls to load virtualized rows, scrapes groups, runs a balance check, then optionally updates Sheets. It saves **screenshots** under `screenshots/` for debugging.

Press **Enter** in the terminal when prompted to close the browser.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NELNET_USERNAME` | Yes | FSA / Nelnet sign-in username or email |
| `NELNET_PASSWORD` | Yes | Account password |
| `MY_LOANS_URL` | No | Full URL to your My Loans page if auto-navigation fails |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | Path to a Google **service account** JSON key file (e.g. `credentials.json`) |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | No | Spreadsheet ID (optional default in `sheets-push.js`; set this for your sheet) |
| `GOOGLE_SHEETS_TAB` | No | Worksheet name (default `Data`) |
| `MFA_IMAP_HOST` / `MFA_IMAP_USER` / `MFA_IMAP_PASSWORD` | No | IMAP settings to auto-read email OTP (e.g. Gmail [app password](https://myaccount.google.com/apppasswords)) |
| `MFA_IMAP_PORT` | No | Default `993` |
| `MFA_IMAP_MAILBOX` | No | Default `INBOX` |
| `MFA_IMAP_MAX_WAIT_MS` | No | Max wait for the MFA email |
| `MFA_IMAP_DEBUG` | No | Set to `1` for extra IMAP logging |
| `MFA_EMAIL_FROM_CONTAINS` | No | Filter sender (default matches Nelnet) |
| `MFA_EMAIL_SUBJECT_CONTAINS` | No | Optional subject filter |

If IMAP is not configured, the script pauses for you to enter the MFA code manually, then you press Enter in the terminal.

## Google Sheets

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Sheets API** and create a **service account**.
2. Download the JSON key and point `GOOGLE_APPLICATION_CREDENTIALS` at it (keep it out of git; `credentials.json` is gitignored if you use that name).
3. **Share** the spreadsheet with the service account email (`…@….iam.gserviceaccount.com`) as **Editor**.
4. The **Data** tab is cleared from `A2` through `D2000`, then rows are written with: **Group**, **Interest rate**, **Principal balance**, **Unpaid interest** (columns A–D).

If `GOOGLE_APPLICATION_CREDENTIALS` is unset, the scraper skips Sheets and only logs to the console.

## What gets scraped

- Groups are detected from **“Group: …”** headings and Nelnet `data-cy` attributes, including:
  - `interest-rate-value`
  - `principal-balance-value`
  - `group-unpaid-accrued-interest-value` (unpaid accrued interest)
- Sum of principal + unpaid interest per row is compared to **`current-balance-value`**. A large mismatch triggers a warning and one extra scroll + re-scrape attempt.

## Project layout

| File | Role |
|------|------|
| `scraper.js` | Playwright flow: login, MFA, disclaimer, My Loans, scrape, Sheets |
| `mfa-email.js` | IMAP polling and OTP extraction from Nelnet email |
| `sheets-push.js` | Google Sheets API write |
| `.env.example` | Template for secrets and options |

## Security

- Never commit `.env`, `credentials.json`, or other service account keys.
- Prefer **app passwords** for IMAP, not your main email password.
- Rotate keys and passwords if they are ever exposed.

