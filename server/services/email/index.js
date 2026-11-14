import { consoleMailer } from './console.js';
import { smtpMailer } from './smtp.js';

/**
 * Sending mail. The application only ever calls `send({ to, subject, html, text })`, so swapping SMTP for an API
 * provider later means replacing one object here and touching nothing that composes a message.
 *
 * WHICH ONE IS USED, and why it is not a setting:
 *
 *   SMTP_HOST configured  -> real mail goes out over SMTP.
 *   nothing configured    -> the console mailer, which writes the message to the log and sends nothing.
 *
 * The default is the one that cannot surprise anybody. A half-configured installation, a developer's laptop and the
 * test suite all land on the console mailer, so the failure mode of forgetting to configure mail is "no mail", not
 * "mail to a real pharmacy from somebody's machine". Sending is something you must switch on deliberately.
 *
 * Nothing here retries. A send that fails is reported to the caller, which logs it and carries on to the next
 * organization - one bad address must never stop a run.
 */

export const emailConfigured = () => Boolean(process.env.SMTP_HOST?.trim());

/** The mailer in use. Read per call, so a test can set the environment and get the mailer it expects. */
export const getMailer = () => (emailConfigured() ? smtpMailer : consoleMailer);

/**
 * Sends one message. Returns `{ sent, id?, previewUrl?, error? }` and NEVER throws: every caller of this is a loop
 * over organizations, and an exception from one of them would mean the rest never hear about their expiring stock.
 */
export async function sendEmail(message) {
  const to = String(message.to || '').trim();
  if (!to) return { sent: false, error: 'No recipient address.' };

  try {
    const result = await getMailer().send({ ...message, to, from: fromAddress() });
    return { sent: true, ...result };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

/** Who the mail comes from. A real address is required for SMTP; the console mailer does not care. */
export const fromAddress = () => process.env.MAIL_FROM?.trim() || 'Usha Pharmacy <no-reply@localhost>';

/** The public address of the web app, for links inside an email. The server has no other way to know it. */
export const appUrl = () => (process.env.APP_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
