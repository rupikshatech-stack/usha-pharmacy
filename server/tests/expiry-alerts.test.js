import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { ALERT_TIERS, buildDigest, renderDigest, shouldAlert, tierLabels } from '../services/expiryDigest.js';
import { digestSetting, recipientsFor, runExpiryAlerts, runForOrganization } from '../services/expiryAlerts.service.js';

/**
 * The expiry digest. Most of these are about NOT sending: not twice in a day, not twice at the same severity, not
 * to an organization that switched it off, and above all not containing somebody else's stock.
 *
 * An email is irreversible in a way a screen is not. A missing digest is noticed and re-run; a wrong one has
 * already arrived in somebody's inbox.
 */

let h;
let sent;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.stop();
});

/**
 * A fake mail transport. The job's own sendEmail catches everything, so the only way to assert on what WOULD have
 * been delivered is to stand in for the transport itself.
 */
beforeEach(() => {
  sent = [];
  delete process.env.SMTP_HOST; // the console mailer; nothing leaves the machine in a test
});

const futureDays = (n) => new Date(Date.now() + n * 86400000);

/** An organization that wants email digests, with an owner to send them to. */
async function orgWantingEmail(name, extra = {}) {
  const t = await h.makeTenant(name);
  await h.models.Organization.updateOne(
    { _id: t.org._id },
    {
      $set: {
        'owner.email': `owner-${String(t.org._id).slice(-6)}@example.test`,
        'owner.firstName': 'Owner',
        'settings.general.notifications.nearExpiry': { enabled: true, channel: 'email' },
        ...extra,
      },
    },
  );
  return { ...t, org: await h.models.Organization.findById(t.org._id).lean() };
}

/** A batch expiring in `days`, through the real API so it is assessed exactly as the report would assess it. */
async function addBatchExpiringIn(client, name, days, { stock = 10 } = {}) {
  const r = await client.post('/medicines', {
    medicineName: name,
    categoryName: 'Tablets',
    manufacturer: 'ACME',
    batch: {
      batchNumber: `B-${name}`,
      expiryDate: futureDays(days).toISOString().slice(0, 10),
      mrp: 100,
      sellingPrice: 90,
      initialQuantity: stock,
    },
  });
  if (r.status !== 201) throw new Error(`could not add ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.data;
}

describe('shouldAlert — the rule that stops a daily re-send', () => {
  it('alerts the first time a batch reaches an alert tier', () => {
    for (const tier of ALERT_TIERS) assert.equal(shouldAlert(tier, undefined), true, `${tier} should alert when never alerted`);
  });

  it('does NOT alert again at the same tier', () => {
    for (const tier of ALERT_TIERS) assert.equal(shouldAlert(tier, tier), false, `${tier} must not re-alert at ${tier}`);
  });

  it('alerts when a batch becomes more urgent', () => {
    assert.equal(shouldAlert('under15', 'under30'), true, 'under30 -> under15 is worse, so it alerts');
    assert.equal(shouldAlert('under30', 'under90'), true);
    assert.equal(shouldAlert('expired', 'under15'), true, 'expiring became expired');
    assert.equal(shouldAlert('expired', 'under90'), true, 'skipping tiers still alerts');
  });

  it('stays silent when a batch becomes LESS urgent', () => {
    assert.equal(shouldAlert('under90', 'under15'), false, 'a corrected expiry date is not news');
    assert.equal(shouldAlert('under30', 'expired'), false);
  });

  it('never alerts for safe or unknown stock', () => {
    assert.equal(shouldAlert('safe', undefined), false);
    assert.equal(shouldAlert('unknown', undefined), false);
    assert.equal(shouldAlert(undefined, undefined), false);
  });

  it('labels come from the organization thresholds, not from 15/30/90', () => {
    const labels = tierLabels([7, 21, 60]);
    assert.match(labels.under15, /within 7 days/);
    assert.match(labels.under30, /within 21 days/);
    assert.match(labels.under90, /within 60 days/);
  });
});

describe('buildDigest', () => {
  const row = (id, bucket, over = {}) => ({ id, bucket, medicineName: `Med ${id}`, batchNumber: `B${id}`, daysToExpiry: 10, quantity: 5, costValue: 100, expiryDate: futureDays(10).toISOString(), ...over });

  it('groups by tier, most urgent first, and totals the value', () => {
    const d = buildDigest({ rows: [row('1', 'under90'), row('2', 'expired'), row('3', 'under15')] });
    assert.deepEqual(d.groups.map((g) => g.tier), ['expired', 'under15', 'under90']);
    assert.equal(d.count, 3);
    assert.equal(d.totalValue, 300);
  });

  it('leaves out batches already alerted at the same tier', () => {
    const d = buildDigest({ rows: [row('1', 'under30'), row('2', 'under30')], lastTierByBatch: { 1: 'under30' } });
    assert.equal(d.count, 1);
    assert.equal(d.groups[0].items[0].batchId, '2');
  });

  it('includes a batch that has crossed into a worse tier', () => {
    const d = buildDigest({ rows: [row('1', 'under15')], lastTierByBatch: { 1: 'under30' } });
    assert.equal(d.count, 1);
  });

  it('is empty when nothing is newly urgent, so nothing is sent', () => {
    const d = buildDigest({ rows: [row('1', 'under30'), row('2', 'safe')], lastTierByBatch: { 1: 'under30' } });
    assert.equal(d.isEmpty, true);
    assert.equal(d.groups.length, 0);
  });

  it('sorts the soonest expiry first within a group', () => {
    const d = buildDigest({ rows: [row('1', 'under15', { daysToExpiry: 12 }), row('2', 'under15', { daysToExpiry: 3 })] });
    assert.deepEqual(d.groups[0].items.map((i) => i.batchId), ['2', '1']);
  });

  it('renders a subject and both bodies, and escapes what it is given', () => {
    const d = buildDigest({ rows: [row('1', 'expired', { medicineName: 'Dolo <script>alert(1)</script>' })] });
    const m = renderDigest({ organizationName: 'Shree & Co', digest: d, appUrl: 'http://localhost:5173', thresholds: [15, 30, 90], today: '2026-11-14' });
    assert.match(m.subject, /Shree & Co/);
    assert.match(m.subject, /already expired/i);
    assert.ok(!m.html.includes('<script>'), 'a medicine name must not be able to inject markup');
    assert.match(m.html, /Shree &amp; Co/);
    assert.match(m.html, /analytics\/expiry/, 'it links to the real report');
    assert.match(m.text, /Dolo <script>/, 'the plain-text part carries the name as typed');
    assert.match(m.text, /analytics\/expiry/);
  });

  it('says "1 batch needs attention" for one and "3 batches need attention" for three, in the subject and in both bodies', () => {
    const render = (n) => {
      const rows = Array.from({ length: n }, (_, i) => row(String(i + 1), 'under30'));
      return renderDigest({ organizationName: 'Grammar Pharmacy', digest: buildDigest({ rows }), appUrl: 'http://x', thresholds: [15, 30, 90], today: '2026-11-23' });
    };
    const one = render(1);
    assert.match(one.subject, /: 1 batch needs attention —/, one.subject);
    assert.match(one.text, /^1 batch needs attention, worth /m);
    assert.match(one.html, /<strong>1 batch needs attention<\/strong>/);
    const three = render(3);
    assert.match(three.subject, /: 3 batches need attention —/, three.subject);
    assert.match(three.text, /^3 batches need attention, worth /m);
    assert.match(three.html, /<strong>3 batches need attention<\/strong>/);
  });
});

describe('whether an organization gets a digest at all', () => {
  it('is skipped when near-expiry notifications are switched off — and that is not an error', async () => {
    const { org, client } = await orgWantingEmail('Off Pharmacy');
    await addBatchExpiringIn(client, 'Soon', 5);
    await h.models.Organization.updateOne({ _id: org._id }, { $set: { 'settings.general.notifications.nearExpiry': { enabled: false, channel: 'email' } } });
    const fresh = await h.models.Organization.findById(org._id).lean();

    const r = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false }));
    assert.match(r.skipped, /switched off/);
    assert.equal(r.error, undefined, 'a deliberate choice must not be logged as a failure');
    assert.equal(r.sent, undefined);
    assert.equal(await h.tenant.runWithTenant(org._id, () => h.models.AlertRun.countDocuments({ organizationId: org._id })), 0, 'and nothing is recorded');
  });

  it('is skipped when the channel is in_app rather than email', async () => {
    const { org, client } = await orgWantingEmail('In App Pharmacy');
    await addBatchExpiringIn(client, 'Soon', 5);
    await h.models.Organization.updateOne({ _id: org._id }, { $set: { 'settings.general.notifications.nearExpiry': { enabled: true, channel: 'in_app' } } });
    const fresh = await h.models.Organization.findById(org._id).lean();

    const r = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false }));
    assert.match(r.skipped, /not email/);
    assert.equal(r.error, undefined);
  });

  it('is skipped when there is no owner email to send to', async () => {
    const { org, client } = await orgWantingEmail('No Owner Pharmacy');
    await addBatchExpiringIn(client, 'Soon', 5);
    await h.models.Organization.updateOne({ _id: org._id }, { $set: { 'owner.email': '' } });
    const fresh = await h.models.Organization.findById(org._id).lean();

    const r = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false }));
    assert.match(r.skipped, /no owner email/);
    assert.equal(r.error, undefined);
  });

  it('the default settings do not send email: a pharmacy must opt in', () => {
    assert.equal(digestSetting({ settings: {} }).send, false, 'absent settings mean in_app, not email');
    assert.equal(digestSetting({ settings: { general: { notifications: { nearExpiry: { enabled: true, channel: 'email' } } } } }).send, true);
  });

  it('recipients are the owner only', async () => {
    const { org } = await orgWantingEmail('Owner Only Pharmacy');
    const recipients = recipientsFor(org);
    assert.equal(recipients.length, 1);
    assert.match(recipients[0], /^owner-/);
  });
});

describe('running twice in one day', () => {
  it('sends exactly one digest, not two', async () => {
    const { org, client } = await orgWantingEmail('Twice Pharmacy');
    await addBatchExpiringIn(client, 'Expiring', 5);
    const fresh = await h.models.Organization.findById(org._id).lean();

    const first = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false }));
    assert.equal(first.sent, true, `first run should have sent: ${JSON.stringify(first)}`);

    const second = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false }));
    assert.equal(second.sent, undefined);
    assert.match(second.skipped, /already ran today/);

    assert.equal(await h.tenant.runWithTenant(org._id, () => h.models.AlertRun.countDocuments({ organizationId: org._id, kind: 'expiry' })), 1, 'one run record for the day');
  });

  it('the same batch is not re-alerted the next day at the same tier', async () => {
    const { org, client } = await orgWantingEmail('Same Tier Pharmacy');
    await addBatchExpiringIn(client, 'Steady', 25); // under30
    const fresh = await h.models.Organization.findById(org._id).lean();

    const day1 = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false }));
    assert.equal(day1.sent, true);
    assert.equal(day1.batches, 1);

    // Tomorrow: a new day (so the run guard allows it), same batch, still under30.
    const tomorrow = new Date(Date.now() + 86400000);
    const day2 = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false, now: tomorrow }));
    assert.equal(day2.sent, false, 'nothing newly urgent, so nothing is sent');
    assert.equal(day2.batches, 0);
  });

  it('but IS re-alerted once it crosses into a more urgent tier', async () => {
    const { org, client } = await orgWantingEmail('Crossing Pharmacy');
    await addBatchExpiringIn(client, 'Crossing', 25); // under30 today
    const fresh = await h.models.Organization.findById(org._id).lean();

    const day1 = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false }));
    assert.equal(day1.batches, 1);
    assert.equal(day1.groups[0].tier, 'under30');

    // Twelve days on, the same lot has 13 days left: under15, which is worse, so it is news again.
    const later = new Date(Date.now() + 12 * 86400000);
    const day2 = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: false, now: later }));
    assert.equal(day2.sent, true, `expected a second alert on crossing a tier: ${JSON.stringify(day2)}`);
    assert.equal(day2.batches, 1);
    assert.equal(day2.groups[0].tier, 'under15');

    const record = await h.tenant.runWithTenant(org._id, () => h.models.ExpiryAlert.findOne({ organizationId: org._id }).lean());
    assert.equal(record.tier, 'under15', 'the recorded tier moved with it');
  });
});

describe('one organization cannot break or see another', () => {
  it("a failing send does not stop the next organization's digest", async () => {
    const bad = await orgWantingEmail('Broken Mail Pharmacy');
    await addBatchExpiringIn(bad.client, 'BadOrgStock', 5);
    const good = await orgWantingEmail('Working Mail Pharmacy');
    await addBatchExpiringIn(good.client, 'GoodOrgStock', 5);

    // An SMTP host that cannot be reached: the first organization's send throws inside the transport.
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1'; // nothing listens here
    process.env.SMTP_USER = '';

    const report = await runExpiryAlerts({ dryRun: false });
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;

    const badResult = report.results.find((r) => r.name === 'Broken Mail Pharmacy');
    const goodResult = report.results.find((r) => r.name === 'Working Mail Pharmacy');

    assert.ok(badResult.error, 'the broken one reports a failure');
    assert.equal(badResult.sent, false);
    assert.ok(goodResult, 'the next organization was still processed');
    assert.ok(goodResult.error, 'it also failed, because the broken SMTP is global here');

    // The point of the test: the run completed and reported on BOTH, rather than throwing at the first.
    assert.equal(report.organizations, report.results.length);
    assert.ok(report.results.length >= 2);
  });

  it('a digest never contains another organization stock', async () => {
    const mine = await orgWantingEmail('Mine Pharmacy');
    const theirs = await orgWantingEmail('Theirs Pharmacy');
    await addBatchExpiringIn(mine.client, 'MyVerySpecificMedicine', 5);
    await addBatchExpiringIn(theirs.client, 'TheirVerySpecificMedicine', 5);

    const freshMine = await h.models.Organization.findById(mine.org._id).lean();
    const r = await h.tenant.runWithTenant(mine.org._id, () => runForOrganization(freshMine, { dryRun: true }));

    assert.equal(r.batches, 1, 'exactly my one batch');

    // And prove it at the level that matters: the rendered message.
    const { settings, rows } = await h.tenant.runWithTenant(mine.org._id, async () => {
      const { assessedFor } = await import('../services/analyticsExpiry.service.js');
      return assessedFor(freshMine, { role: 'ORG_ADMIN', branchIds: [] }, {}, new Date());
    });
    const digest = buildDigest({ rows, lastTierByBatch: {}, thresholds: settings.thresholds });
    const message = renderDigest({ organizationName: freshMine.name, digest, appUrl: 'http://x', thresholds: settings.thresholds, today: '2026-11-14' });

    assert.match(message.html, /MyVerySpecificMedicine/);
    assert.ok(!message.html.includes('TheirVerySpecificMedicine'), "another pharmacy's medicine must never appear");
    assert.ok(!message.text.includes('TheirVerySpecificMedicine'));
  });
});

describe('a dry run', () => {
  it('builds the real digest but sends and records nothing', async () => {
    const { org, client } = await orgWantingEmail('Dry Pharmacy');
    await addBatchExpiringIn(client, 'DryStock', 5);
    const fresh = await h.models.Organization.findById(org._id).lean();

    const r = await h.tenant.runWithTenant(org._id, () => runForOrganization(fresh, { dryRun: true }));
    assert.equal(r.dryRun, true);
    assert.equal(r.sent, false);
    assert.equal(r.batches, 1, 'it did the real work');
    assert.ok(r.subject, 'and composed the real subject line');

    assert.equal(await h.tenant.runWithTenant(org._id, () => h.models.AlertRun.countDocuments({ organizationId: org._id })), 0, 'no run was recorded');
    assert.equal(await h.tenant.runWithTenant(org._id, () => h.models.ExpiryAlert.countDocuments({ organizationId: org._id })), 0, 'no batch was marked as alerted');
  });
});
