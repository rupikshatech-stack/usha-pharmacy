import { Invoice } from '../../models/index.js';
import { classifyForSeeding, plan, sequenceIfIssuedBy } from '../../utils/documentNumber.js';
import { financialYearOf } from '../../utils/financialYear.js';
import { orgTimezone } from '../../services/organization.service.js';
import { correctCounter, issueNumber } from '../../services/documentNumbering.service.js';

/**
 * Demo sales history for the seed scripts, numbered the way a real invoice is.
 *
 * The first version of the expiry demo wrote its invoices as `EXP-DEMO-001 … 090`: numbers invented by hand, in a format
 * no series ever prints. They sat in the SALES scope next to real invoices, and the migration that read the digits off
 * every number raised a real counter to 90 because of them. Demo data should look like data, so these are issued
 * through the same series formatter and the same atomic counter as any other invoice: `INV-00008`, `INV-00009`, … in
 * whatever format the organization has configured, oldest first, consecutive, with the financial-year segment each
 * invoice's OWN date calls for.
 *
 * Demo invoices are recognised by their idempotency key (`exp-demo-<n>`), not by looking like a demo, and the older
 * `EXP-DEMO-` rows are still recognised so a database seeded by the earlier version cleans itself up.
 *
 * RE-SEEDING WITHOUT LEAVING A GAP. Deleting demo invoices that already own numbers would leave holes in a series that
 * is supposed to be consecutive. So when the demo invoices are the TAIL of the series - nothing real was issued after
 * them - the counter is rewound (through the same strict, transactional, audited correction used for fixing a wrong
 * counter) and the numbers are issued again, identical. If a real invoice was issued after any demo one, the demo
 * invoices are left exactly as they are: removing them would punch a hole in the middle of real numbers.
 */
export const DEMO_KEY = /^exp-demo-/;
const DEMO_FILTER = { $or: [{ idempotencyKey: DEMO_KEY }, { invoiceNo: /^EXP-DEMO-/ }] };

export async function replaceDemoSales({ orgId, org, branch, userId, drafts, series = 'sales' }) {
  const tz = orgTimezone(org);
  const startMonth = org?.settings?.fiscalYearStartMonth || 4;
  const labelFor = (date) => financialYearOf(date ? new Date(date) : new Date(), startMonth, tz).label;
  const p = plan({ numbering: org?.settings?.invoice, series, branchId: branch._id, org, tz });

  const existing = await Invoice.find({ organizationId: orgId, ...DEMO_FILTER }).select('invoiceNo invoiceDate').lean();
  const result = { removed: 0, created: 0, kept: 0, first: null, last: null, rewound: false, note: null };

  if (existing.length) {
    const demoIds = new Set(existing.map((d) => String(d._id)));
    const everything = await Invoice.find({ organizationId: orgId }).select('invoiceNo invoiceDate').lean();
    const asDocs = (list) => list.map((d) => ({ _id: d._id, number: d.invoiceNo, date: d.invoiceDate }));
    const real = classifyForSeeding({ docs: asDocs(everything.filter((d) => !demoIds.has(String(d._id)))), config: p.config, labelFor });

    // Demo invoices that carry a real series number (the new kind) own serials. If anything real sits ABOVE the lowest
    // of them, deleting them would leave a hole in the middle of real numbers - so they are left alone.
    const demoSerials = asDocs(existing)
      .map((d) => sequenceIfIssuedBy(p.config, d.number, { financialYearLabel: labelFor(d.date) }))
      .filter((n) => n !== null);
    const lowestDemoSerial = demoSerials.length ? Math.min(...demoSerials) : null;
    if (lowestDemoSerial !== null && real.highest > lowestDemoSerial) {
      return {
        ...result,
        kept: existing.length,
        note: `Real invoices (up to ${real.highest}) were issued after the demo ones began (${lowestDemoSerial}), so removing the demo invoices would leave a gap in the middle of real numbers. They were left exactly as they are, and no new demo invoices were added.`,
      };
    }

    await Invoice.deleteMany({ organizationId: orgId, _id: { $in: [...demoIds] } });
    result.removed = existing.length;

    // Give the numbers back. The correction is strict - one transaction, nothing above the target, audited - and a
    // counter that is already where it should be is simply left alone.
    const rewind = await correctCounter({
      orgId,
      org,
      series,
      branchId: null,
      to: real.highest,
      reason: 'demo invoices were removed to be re-seeded, so the serials they used are returned',
      actor: 'seed:expiry',
      dryRun: false,
    });
    result.rewound = Boolean(rewind.applied);
  }

  // Oldest first, so the lowest numbers go to the earliest sales and the series reads in date order.
  const docs = [];
  for (const draft of [...drafts].sort((a, b) => a.invoiceDate - b.invoiceDate)) {
    const issued = await issueNumber({ orgId, org, series, branchId: branch._id, now: draft.invoiceDate });
    docs.push({ ...draft, organizationId: orgId, invoiceNo: issued.number, branchId: branch._id, branchName: branch.name, createdBy: userId, idempotencyKey: `exp-demo-${draft.key}` });
  }
  if (docs.length) await Invoice.insertMany(docs);
  return { ...result, created: docs.length, first: docs[0]?.invoiceNo || null, last: docs.at(-1)?.invoiceNo || null };
}
