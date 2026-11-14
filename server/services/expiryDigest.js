import { BUCKETS } from './expiryRisk.js';

/**
 * Deciding what goes in a digest, and writing it. Pure functions only — no database, no mail, no clock of its own.
 * Everything that is hard to reason about lives here so it can be tested directly.
 */

/** The tiers a digest ever mentions, most urgent first. 'safe' is not an alert, and 'unknown' is not a tier. */
export const ALERT_TIERS = ['expired', 'under15', 'under30', 'under90'];

/** How urgent a tier is: lower is worse. Anything not an alert tier sorts after all of them. */
const urgency = (tier) => {
  const i = ALERT_TIERS.indexOf(tier);
  return i === -1 ? ALERT_TIERS.length : i;
};

/**
 * Is this batch worth emailing about now?
 *
 * Only when it has become MORE urgent than the last tier it was emailed about. That single rule gives all three
 * behaviours wanted: a new arrival in a tier is sent (nothing was recorded before), the same tier tomorrow is
 * silent, and crossing into a worse tier sends again.
 *
 * Becoming LESS urgent is silent too — an expiry date corrected from next week to next year is good news and not
 * worth an email — but the recorded tier still moves, so that if it ever worsens again it is treated as the new
 * arrival it is.
 */
export function shouldAlert(tier, lastAlertedTier) {
  if (!ALERT_TIERS.includes(tier)) return false;
  if (!lastAlertedTier) return true;
  return urgency(tier) < urgency(lastAlertedTier);
}

/** Human labels, built from the organization's own thresholds — never the hard-coded 15/30/90. */
export function tierLabels(thresholds = [15, 30, 90]) {
  const [near, soon, later] = thresholds;
  return {
    expired: 'Already expired',
    under15: `Expiring within ${near} days`,
    under30: `Expiring within ${soon} days`,
    under90: `Expiring within ${later} days`,
  };
}

/**
 * The rows that belong in today's digest, grouped by tier, most urgent group first.
 *
 * `rows` are assessed lots from analyticsExpiry.service.js; `lastTierByBatch` maps a batch id to the tier it was
 * last emailed about. Only rows that pass `shouldAlert` appear, so a quiet day produces no groups at all and the
 * caller knows not to send anything.
 */
export function buildDigest({ rows, lastTierByBatch = {}, thresholds = [15, 30, 90] }) {
  const labels = tierLabels(thresholds);
  const groups = [];
  let totalValue = 0;
  let count = 0;

  for (const tier of ALERT_TIERS) {
    const items = rows
      .filter((r) => r.bucket === tier && shouldAlert(tier, lastTierByBatch[String(r.id ?? r.batchId ?? r._id)]))
      .map((r) => ({
        // `id` is what presentRow() calls the batch id; the other names are taken from the same row verbatim so
        // the email and the Expiry Intelligence table can never quote different numbers for the same lot.
        batchId: String(r.id ?? r.batchId ?? r._id),
        medicineName: r.medicineName || 'Unknown medicine',
        batchNumber: r.batchNumber || '—',
        expiryDate: r.expiryDate,
        daysToExpiry: r.daysToExpiry,
        quantity: r.quantity ?? 0,
        // What the stock cost, which is what is actually lost if it expires on the shelf — the same figure the
        // report's "value at cost" column shows.
        value: Number(r.costValue ?? r.value ?? 0),
      }))
      // Soonest first inside a group: the thing expiring on Tuesday matters more than the one expiring on Friday.
      .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0) || a.medicineName.localeCompare(b.medicineName));

    if (!items.length) continue;
    const value = items.reduce((n, i) => n + i.value, 0);
    groups.push({ tier, label: labels[tier], items, count: items.length, value });
    totalValue += value;
    count += items.length;
  }

  return { groups, count, totalValue, isEmpty: count === 0 };
}

const inr = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dateOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

/** The colour down the left of each group. Red for gone, amber for soon, grey for the long tail. */
const TIER_COLOUR = { expired: '#b42318', under15: '#b54708', under30: '#b54708', under90: '#475467' };

/**
 * The message itself: subject, HTML and a plain-text fallback carrying the same information.
 *
 * The HTML is a table with inline styles and no images. Mail clients strip stylesheets, block remote images by
 * default, and a pharmacist reading this on a phone at seven in the morning should see the numbers either way.
 */
export function renderDigest({ organizationName, digest, appUrl, thresholds, today }) {
  const link = `${appUrl}/analytics/expiry`;
  const worst = digest.groups[0];
  const subject = `${organizationName}: ${digest.count} ${digest.count === 1 ? 'batch' : 'batches'} need attention — ${worst.label.toLowerCase()}`;

  const text = [
    `${organizationName} — expiring stock, ${today}`,
    '',
    `${digest.count} ${digest.count === 1 ? 'batch needs' : 'batches need'} attention, worth ${inr(digest.totalValue)}.`,
    '',
    ...digest.groups.flatMap((g) => [
      `${g.label} — ${g.count} ${g.count === 1 ? 'batch' : 'batches'}, ${inr(g.value)}`,
      ...g.items.map((i) => `  · ${i.medicineName} (batch ${i.batchNumber}) — ${i.quantity} units, ${inr(i.value)}, expires ${dateOf(i.expiryDate)}`),
      '',
    ]),
    `See the full report: ${link}`,
    '',
    'You are receiving this because near-expiry email alerts are switched on for this pharmacy.',
    'Turn them off under Settings → Common Settings → Notifications.',
  ].join('\n');

  const group = (g) => `
    <tr><td style="padding:18px 0 6px">
      <div style="border-left:4px solid ${TIER_COLOUR[g.tier]};padding-left:10px">
        <div style="font:600 15px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;color:#101828">${escapeHtml(g.label)}</div>
        <div style="font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#475467">${g.count} ${g.count === 1 ? 'batch' : 'batches'} · ${inr(g.value)}</div>
      </div>
    </td></tr>
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif">
        <tr style="color:#475467;text-align:left">
          <th style="padding:6px 8px;border-bottom:1px solid #eaecf0;font-weight:600">Medicine</th>
          <th style="padding:6px 8px;border-bottom:1px solid #eaecf0;font-weight:600">Batch</th>
          <th style="padding:6px 8px;border-bottom:1px solid #eaecf0;font-weight:600;text-align:right">Qty</th>
          <th style="padding:6px 8px;border-bottom:1px solid #eaecf0;font-weight:600;text-align:right">Value</th>
          <th style="padding:6px 8px;border-bottom:1px solid #eaecf0;font-weight:600">Expires</th>
        </tr>
        ${g.items
          .map(
            (i) => `<tr>
          <td style="padding:7px 8px;border-bottom:1px solid #f2f4f7;color:#101828">${escapeHtml(i.medicineName)}</td>
          <td style="padding:7px 8px;border-bottom:1px solid #f2f4f7;color:#475467">${escapeHtml(i.batchNumber)}</td>
          <td style="padding:7px 8px;border-bottom:1px solid #f2f4f7;text-align:right;color:#101828">${i.quantity}</td>
          <td style="padding:7px 8px;border-bottom:1px solid #f2f4f7;text-align:right;color:#101828">${inr(i.value)}</td>
          <td style="padding:7px 8px;border-bottom:1px solid #f2f4f7;color:#475467">${dateOf(i.expiryDate)}</td>
        </tr>`,
          )
          .join('')}
      </table>
    </td></tr>`;

  const html = `<!doctype html>
<html><body style="margin:0;background:#f9fafb;padding:24px 12px">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #eaecf0;border-radius:12px;padding:24px">
    <tr><td>
      <div style="font:700 18px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;color:#101828">${escapeHtml(organizationName)}</div>
      <div style="font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#475467;margin-top:2px">Expiring stock · ${escapeHtml(today)}</div>
      <div style="font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#101828;margin-top:14px">
        <strong>${digest.count} ${digest.count === 1 ? 'batch needs' : 'batches need'} attention</strong>, worth ${inr(digest.totalValue)}.
      </div>
    </td></tr>
    ${digest.groups.map(group).join('')}
    <tr><td style="padding-top:22px">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#1b4332;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font:600 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif">Open Expiry Intelligence</a>
    </td></tr>
    <tr><td style="padding-top:20px;border-top:1px solid #eaecf0;margin-top:16px">
      <div style="font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#667085;padding-top:14px">
        Thresholds for this pharmacy: ${thresholds.join(' / ')} days. You are receiving this because near-expiry email
        alerts are switched on — change that under Settings → Common Settings → Notifications.
      </div>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}
