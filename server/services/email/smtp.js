import nodemailer from 'nodemailer';

/**
 * Real SMTP, through nodemailer. Configured entirely from the environment:
 *
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
 *
 * The transport is built once and reused: creating one per message opens a new connection every time, which a mail
 * server is entitled to treat as abuse.
 *
 * `previewUrl` is populated for Ethereal, the throwaway inbox used to look at a real rendered message without any
 * mail leaving the machine. It is null for every other provider.
 */
let transport = null;
let signature = null;

const config = () => ({
  host: process.env.SMTP_HOST?.trim(),
  port: Number(process.env.SMTP_PORT || 587),
  // Port 465 is implicit TLS; 587 upgrades with STARTTLS. Setting SMTP_SECURE overrides the guess.
  secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT || 587) === 465,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
});

function getTransport() {
  const c = config();
  const key = JSON.stringify(c);
  // Rebuilt only if the configuration actually changed, which in practice means a test swapping it out.
  if (!transport || signature !== key) {
    transport = nodemailer.createTransport(c);
    signature = key;
  }
  return transport;
}

export const smtpMailer = {
  name: 'smtp',
  async send({ to, from, subject, html, text }) {
    const info = await getTransport().sendMail({ to, from, subject, html, text });
    return { id: info.messageId, transport: 'smtp', previewUrl: nodemailer.getTestMessageUrl(info) || null };
  },
};
