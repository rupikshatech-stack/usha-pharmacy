/**
 * The mailer used when no SMTP server is configured: it writes what WOULD have been sent and sends nothing.
 *
 * This is the default on purpose. An unconfigured installation, a developer's laptop and the test suite all end up
 * here, so forgetting to set SMTP_HOST means no mail rather than unexpected mail to a real pharmacy.
 */
export const consoleMailer = {
  name: 'console',
  async send({ to, subject, text }) {
    const body = String(text || '').split('\n').slice(0, 12).join('\n');
    console.log(`[email:console] would send to ${to}\n  subject: ${subject}\n${body.replace(/^/gm, '  | ')}\n  (not sent — SMTP_HOST is not configured)`);
    return { id: `console-${Date.now()}`, transport: 'console' };
  },
};
