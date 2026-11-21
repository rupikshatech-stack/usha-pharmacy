// Usage:
//   node scripts/run-expiry-alerts.js --dry-run            (the default: builds the real digests, sends nothing)
//   node scripts/run-expiry-alerts.js --apply
//   node scripts/run-expiry-alerts.js --apply --org <id>   (one organization, for testing)
//   node scripts/run-expiry-alerts.js --apply --ethereal   (a throwaway inbox; prints a preview link, sends no real mail)
//
// The daily near-expiry digest. This is the scheduled entry point — nothing in the web application triggers it, and
// it must not be made to: an email that goes out when somebody opens a page is an email nobody can predict.
// (On Vercel there is no Task Scheduler: Vercel Cron calls GET /api/cron/expiry-alerts, which refuses to run without
// the CRON_SECRET bearer token. See routes/cron.routes.js.)
//
// SCHEDULING (Windows Task Scheduler, daily, early — before the pharmacy opens):
//
//   Program:   node
//   Arguments: scripts/run-expiry-alerts.js --apply
//   Start in:  D:\UshaPharmacy\server
//
// Running it twice in a day is safe: the second run finds the day already claimed and stops without sending.
//
// MAIL CONFIGURATION lives in server/.env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, APP_URL). With no
// SMTP_HOST the console mailer is used, which prints the message and sends nothing — so a misconfigured
// installation stays quiet rather than mailing real pharmacies by accident.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { runExpiryAlerts } from '../services/expiryAlerts.service.js';
import { emailConfigured } from '../services/email/index.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const apply = process.argv.includes('--apply');
const dryRun = !apply;
const say = (m = '') => console.log(m);
let exitCode = 0;

try {
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose one: --dry-run or --apply.');

  /**
   * A throwaway inbox from Ethereal: real SMTP, a real rendered message, a link to look at it — and nothing
   * delivered to anybody. It exists so the first run of a mail feature can be inspected without the risk of a
   * misdirected email to a real pharmacy.
   */
  if (process.argv.includes('--ethereal')) {
    const nodemailer = (await import('nodemailer')).default;
    const account = await nodemailer.createTestAccount();
    process.env.SMTP_HOST = account.smtp.host;
    process.env.SMTP_PORT = String(account.smtp.port);
    process.env.SMTP_SECURE = String(account.smtp.secure);
    process.env.SMTP_USER = account.user;
    process.env.SMTP_PASS = account.pass;
    process.env.MAIL_FROM = process.env.MAIL_FROM || `Usha Pharmacy <${account.user}>`;
    say(`\nEthereal test inbox: ${account.user}  (nothing is delivered; each message gets a preview link)`);
  }

  await connectDb();

  const orgId = arg('org');
  if (orgId && !mongoose.Types.ObjectId.isValid(orgId)) throw new Error(`"${orgId}" is not a valid organization id.`);

  say(`\n${dryRun ? 'DRY RUN — no mail will be sent, nothing will be recorded' : 'SENDING'}`);
  say(`mail transport: ${emailConfigured() ? `SMTP (${process.env.SMTP_HOST})` : 'console (SMTP_HOST not set — nothing will actually be delivered)'}`);
  say('');

  const report = await runExpiryAlerts({
    dryRun,
    organizationId: orgId ? new mongoose.Types.ObjectId(orgId) : null,
  });

  for (const r of report.results) {
    const head = `${r.name}`.padEnd(28);
    if (r.skipped) say(`  ${head} skipped — ${r.skipped}`);
    else if (r.error) say(`  ${head} FAILED — ${r.error}`);
    else if (!r.batches) say(`  ${head} nothing newly urgent today`);
    else {
      const groups = (r.groups || []).map((g) => `${g.tier}:${g.count}`).join(' ');
      say(`  ${head} ${dryRun ? 'would send' : 'sent'} ${r.batches} batch(es) [${groups}] to ${(r.recipients || []).join(', ')}`);
      say(`  ${''.padEnd(28)} subject: ${r.subject}`);
      if (r.previewUrl) say(`  ${''.padEnd(28)} PREVIEW: ${r.previewUrl}`);
    }
  }

  say('');
  say(`organizations ${report.organizations}   ${dryRun ? 'would send' : 'sent'} ${report.sent}   skipped ${report.skipped}   failed ${report.failed}`);
  if (dryRun) say('Nothing was sent or recorded. Re-run with --apply to send.');
  say('');

  // A failure for one organization is reported, not fatal: the others were still processed.
  if (report.failed) exitCode = 3;
} catch (e) {
  exitCode = 1;
  console.error('[expiry-alerts] FAILED:', e.message);
} finally {
  await disconnectDb().catch(() => {});
  process.exit(exitCode);
}
