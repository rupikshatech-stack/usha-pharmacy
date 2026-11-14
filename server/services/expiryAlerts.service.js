import { AlertRun, ExpiryAlert, Organization } from '../models/index.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { dayKey } from '../utils/tz.js';
import { orgTimezone } from './organization.service.js';
import { assessedFor } from './analyticsExpiry.service.js';
import { buildDigest, renderDigest } from './expiryDigest.js';
import { appUrl, sendEmail } from './email/index.js';

/**
 * The daily near-expiry digest: one email per organization, listing what has newly become urgent.
 *
 * It is a SCHEDULED job and nothing else. No route reaches it, no page load triggers it — a request that sent mail
 * as a side effect would send a different number of emails depending on how many people opened a page.
 *
 * The shape of a run, per organization, in this order:
 *
 *   1. Is the digest switched on at all? (`settings.general.notifications.nearExpiry`, channel 'email')
 *   2. Claim today, by INSERTING the AlertRun row. A unique index on (org, kind, date) means the second run of the
 *      day loses the insert and stops. Claiming before composing, rather than checking and then sending, is what
 *      makes running it twice safe: there is no window where two runs both believe they are the first.
 *   3. Work out what is newly urgent, from the same assessment the Expiry Intelligence page shows.
 *   4. Send, then record the tier each batch was alerted at.
 *
 * NOTHING HERE THROWS PAST ONE ORGANIZATION. A bad address, an SMTP outage, a malformed record — each is caught,
 * recorded against that organization's run, and the loop moves on. Twenty pharmacies must not go uninformed
 * because the first one's mail server is down.
 */

/** A caller with no branch restriction: the job reports on the whole organization, not one store. */
const JOB_USER = { role: 'ORG_ADMIN', branchIds: [] };

/** Whether this organization wants the digest, and why not when it does not. */
export function digestSetting(org) {
  const n = org?.settings?.general?.notifications?.nearExpiry;
  // Absent means the default, which is enabled + in_app: on for the bell, off for email.
  const enabled = n?.enabled === undefined ? true : Boolean(n.enabled);
  const channel = n?.channel || 'in_app';
  if (!enabled) return { send: false, reason: 'near-expiry notifications are switched off' };
  if (channel !== 'email') return { send: false, reason: `near-expiry channel is "${channel}", not email` };
  return { send: true, channel };
}

/** Who gets it. Owner only, deliberately: see the note in the README about per-user opt-in. */
export const recipientsFor = (org) => [org?.owner?.email?.trim()].filter(Boolean);

/**
 * Runs the digest for one organization. Returns a report; never throws.
 *
 * `dryRun` does everything except send the mail and record anything — it builds the real digest from real data, so
 * what it reports is exactly what a real run would send.
 */
export async function runForOrganization(org, { now = new Date(), dryRun = true } = {}) {
  const base = { organizationId: String(org._id), name: org.name };
  const tz = orgTimezone(org);
  const runDate = dayKey(now, tz);

  try {
    const setting = digestSetting(org);
    // Switched off is a normal outcome, not a failure: no send is attempted and nothing is logged as an error.
    if (!setting.send) return { ...base, runDate, skipped: setting.reason };

    const recipients = recipientsFor(org);
    if (!recipients.length) return { ...base, runDate, skipped: 'no owner email address on the organization profile' };

    // Claim the day before doing any work. On a second run the unique index rejects this and we stop here.
    if (!dryRun) {
      try {
        await AlertRun.create({ organizationId: org._id, kind: 'expiry', runDate, recipients });
      } catch (e) {
        if (e.code === 11000) return { ...base, runDate, skipped: 'already ran today' };
        throw e;
      }
    } else if (await AlertRun.findOne({ organizationId: org._id, kind: 'expiry', runDate }).lean()) {
      return { ...base, runDate, skipped: 'already ran today' };
    }

    // The same assessment the Expiry Intelligence page shows, so the email and the screen always agree.
    const { settings, rows } = await assessedFor(org, JOB_USER, {}, now);

    const alerted = await ExpiryAlert.find({ organizationId: org._id }).select('batchId tier').lean();
    const lastTierByBatch = Object.fromEntries(alerted.map((a) => [String(a.batchId), a.tier]));

    const digest = buildDigest({ rows, lastTierByBatch, thresholds: settings.thresholds });
    if (digest.isEmpty) {
      if (!dryRun) await AlertRun.updateOne({ organizationId: org._id, kind: 'expiry', runDate }, { $set: { sentAt: null, counts: { batches: 0 } } });
      return { ...base, runDate, sent: false, batches: 0, note: 'nothing newly urgent today' };
    }

    const message = renderDigest({
      organizationName: org.name,
      digest,
      appUrl: appUrl(),
      thresholds: settings.thresholds,
      today: runDate,
    });

    if (dryRun) {
      return { ...base, runDate, dryRun: true, sent: false, batches: digest.count, value: digest.totalValue, recipients, subject: message.subject, groups: digest.groups.map((g) => ({ tier: g.tier, count: g.count })) };
    }

    const result = await sendEmail({ to: recipients.join(', '), ...message });
    const counts = { batches: digest.count, value: digest.totalValue, ...Object.fromEntries(digest.groups.map((g) => [g.tier, g.count])) };

    if (!result.sent) {
      await AlertRun.updateOne({ organizationId: org._id, kind: 'expiry', runDate }, { $set: { error: result.error || 'send failed', counts } });
      return { ...base, runDate, sent: false, error: result.error || 'send failed', batches: digest.count };
    }

    /**
     * Recorded only after the mail is away. If the send failed, nothing is written, so tomorrow's run treats these
     * batches as never alerted and tries again — which is the right way round. The opposite ordering would mean a
     * failed send silently marked everything as handled and the pharmacy never heard about it.
     */
    const batchIds = digest.groups.flatMap((g) => g.items.map((i) => ({ id: i.batchId, tier: g.tier })));
    await ExpiryAlert.bulkWrite(
      batchIds.map(({ id, tier }) => ({
        updateOne: {
          filter: { organizationId: org._id, batchId: id },
          update: { $set: { organizationId: org._id, batchId: id, tier, alertedAt: now } },
          upsert: true,
        },
      })),
    );
    await AlertRun.updateOne({ organizationId: org._id, kind: 'expiry', runDate }, { $set: { sentAt: new Date(), counts, error: '' } });

    return { ...base, runDate, sent: true, batches: digest.count, value: digest.totalValue, recipients, subject: message.subject, previewUrl: result.previewUrl || null, groups: digest.groups.map((g) => ({ tier: g.tier, count: g.count })) };
  } catch (e) {
    // One organization's problem stays one organization's problem.
    return { ...base, runDate, sent: false, error: e.message };
  }
}

/** Every organization, one after another. Always resolves; the report says what happened to each. */
export async function runExpiryAlerts({ now = new Date(), dryRun = true, organizationId = null } = {}) {
  const filter = organizationId ? { _id: organizationId } : { status: 'active' };
  const orgs = await Organization.find(filter).lean();

  const results = [];
  for (const org of orgs) {
    // Each organization runs inside its own tenant context, so the Mongoose plugin scopes every read and write for
    // us. A digest cannot contain another pharmacy's stock even if this code asked for it.
    results.push(await runWithTenant(org._id, () => runForOrganization(org, { now, dryRun })));
  }

  return {
    organizations: orgs.length,
    sent: results.filter((r) => r.sent).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => r.error).length,
    results,
  };
}
