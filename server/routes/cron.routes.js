import crypto from 'node:crypto';
import { Router } from 'express';
import { runExpiryAlerts } from '../services/expiryAlerts.service.js';

/**
 * Scheduled jobs, called by Vercel Cron (vercel.json) with `Authorization: Bearer <CRON_SECRET>`.
 *
 * This is NOT a page anybody can open: with no CRON_SECRET configured the route refuses to run at all, and a wrong
 * or missing secret is a 401 before any organization is touched. The digest's own once-per-day claim still applies,
 * so a retried or duplicated call cannot mail a pharmacy twice. Nothing in the web application links here.
 */
const router = Router();

const authorised = (req) => {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

router.get('/expiry-alerts', async (req, res) => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ success: false, message: 'CRON_SECRET is not configured.' });
  if (!authorised(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  const report = await runExpiryAlerts({ dryRun: false });
  // Counts only: the per-organization detail names recipients, which does not belong in a response or a log.
  res.json({ success: true, data: { organizations: report.organizations, sent: report.sent, skipped: report.skipped, failed: report.failed } });
});

export default router;
