import { AuditLog, Counter, Invoice, Order, SalesReturn } from '../models/index.js';
import { withTransaction } from './transaction.service.js';
import { nextSeq } from '../models/Counter.js';
import { orgTimezone } from './organization.service.js';
import { DOCUMENT_SERIES, SERIES_LABEL, classifyForSeeding, plan, sequenceIfIssuedBy } from '../utils/documentNumber.js';
import { financialYearOf } from '../utils/financialYear.js';

/**
 * Issuing a document number, and making sure the counter behind it can never hand out one that already exists.
 *
 * THE INVARIANT: a number is issued exactly once. Everything here exists to protect it, because the failure is not
 * a glitch — it is two customers holding invoices with the same number, which is a tax problem, not a bug report.
 *
 * It rests on one atomic operation: `$inc` on a single counter document. Whatever else is going on — two tills
 * billing at the same instant, a settings change half way through the day, a financial year turning over at
 * midnight — the number itself comes from an increment that MongoDB performs indivisibly, inside the same
 * transaction as the invoice, so a rolled-back sale rolls the number back with it.
 *
 * Two things can move a counter other than issuing:
 *
 *   A CONFIGURED START. A series can be told to begin at 500. The counter is raised to 499 with `$max` — atomic,
 *   idempotent, and safe to race: whoever gets there first wins and the others change nothing. It can only ever
 *   raise, so it cannot walk a counter backwards into numbers already issued.
 *
 *   A NEW COUNTER APPEARING. Turning on per-branch numbering, or a yearly reset, means the next invoice reads a
 *   counter that has never existed, which starts at zero. If the printed format did not change too, that would
 *   re-issue numbers that are already on paper. `seedCounters` therefore raises every reachable counter to the
 *   highest number that scope has actually issued, and it runs whenever the numbering settings are saved.
 */

/** Where each series' numbers live, and how to tell which documents belong to one scope. */
const SOURCE = {
  sales: { model: () => Invoice, field: 'invoiceNo', branchField: 'branchId', dateField: 'invoiceDate' },
  salesReturn: { model: () => SalesReturn, field: 'returnNo', branchField: null, dateField: 'returnDate' },
  purchase: { model: () => Order, field: 'orderNo', branchField: 'branchId', dateField: 'orderDate' },
};

/** The numeric tail of a document number: "INV-00042" -> 42, "SWS/25-26/0007" -> 7, anything else -> 0. */
export const sequenceOf = (s) => {
  const m = /(\d+)\s*$/.exec(String(s || ''));
  return m ? Number(m[1]) : 0;
};

/**
 * Issues the next number for a series, inside the caller's transaction.
 *
 * The sequence is taken from the counter and never parsed back out of a string, so changing a prefix renames what
 * comes next and cannot reach a document that already exists.
 */
export async function issueNumber({ orgId, org, series, branchId = null, session, now = new Date() }) {
  const p = plan({ numbering: org?.settings?.invoice, series, branchId, org, now, tz: orgTimezone(org) });
  const start = Math.max(1, p.config.start || 1);

  // Raise the counter to just below the configured start, if it is behind. `$max` never lowers a counter and
  // never fails a race, so two tills doing this at the same moment agree.
  if (start > 1) {
    await Counter.updateOne({ organizationId: orgId, key: p.key }, { $max: { seq: start - 1 } }, { upsert: true, session });
  }

  const seq = await nextSeq(orgId, p.key, session);
  return { number: p.format(seq), seq, key: p.key, config: p.config, financialYear: p.financialYear };
}

/**
 * Raises every counter a configuration can reach to the highest number that scope has ALREADY ISSUED UNDER THAT
 * SERIES' OWN FORMAT — and only that.
 *
 * GST invoice serials are meant to be consecutive within a series and a financial year, so a counter that jumps is a
 * compliance problem even when nothing collides. Two rules keep it from jumping:
 *
 *   1. A document seeds a counter only if its number is exactly what this series would have printed for it (prefix,
 *      financial-year segment if the format has one, padding and all). `EXP-DEMO-090` ends in 90 but is not an
 *      invoice of this series, so it says nothing about what has been issued.
 *   2. Even a matching number is set aside if it sits more than 1000 above the next-highest one: that is a stray row,
 *      not "the latest invoice".
 *
 * Everything set aside comes back as `needsReview`, with its `_id`, so a person can look at it. It is never used to
 * move a counter, and nothing here modifies a document.
 *
 * Returns what it did (or, with `dryRun`, what it would do). It NEVER lowers a counter. When a counter already stands
 * above everything valid it reports the gap (`gap`) rather than closing it: lowering a counter is not a thing code
 * should do on its own, because the numbers above it might be real.
 */
export async function seedCounters({ orgId, org, branches = [], dryRun = false, session, now = new Date() }) {
  const numbering = org?.settings?.invoice;
  const perBranch = Boolean(numbering?.perBranch);
  const tz = orgTimezone(org);
  const startMonth = org?.settings?.fiscalYearStartMonth || 4;
  const labelFor = (date) => financialYearOf(date ? new Date(date) : now, startMonth, tz).label;
  const report = [];

  for (const series of DOCUMENT_SERIES) {
    const src = SOURCE[series];
    // Which scopes this series can issue into: the organization as a whole, or one per store.
    const scopes = perBranch && src.branchField ? branches.map((b) => ({ branchId: b._id, name: b.name })) : [{ branchId: null, name: 'whole organization' }];

    for (const scope of scopes) {
      const p = plan({ numbering, series, branchId: scope.branchId, org, now, tz });
      const filter = { organizationId: orgId, ...(scope.branchId && src.branchField ? { [src.branchField]: scope.branchId } : {}) };
      // A series that resets each year can only collide with THIS year's documents.
      if (p.config.resetEveryFinancialYear) filter[src.dateField] = { $gte: p.financialYear.start, $lt: p.financialYear.end };

      const found = await src.model().find(filter).select(`${src.field} ${src.dateField}`).lean();
      const docs = found.map((d) => ({ _id: d._id, number: d[src.field], date: d[src.dateField] }));
      const result = classifyForSeeding({ docs, config: p.config, labelFor });

      const counter = await Counter.findOne({ organizationId: orgId, key: p.key }).lean();
      const current = counter?.seq || 0;
      const floor = Math.max(1, p.config.start || 1) - 1;
      const target = Math.max(result.highest, floor);
      const raise = target > current;

      if (raise && !dryRun) {
        await Counter.updateOne({ organizationId: orgId, key: p.key }, { $max: { seq: target } }, { upsert: true, session });
      }

      report.push({
        series,
        label: SERIES_LABEL[series],
        scope: scope.name,
        branchId: scope.branchId ? String(scope.branchId) : null,
        key: p.key,
        documents: docs.length,
        usable: docs.length - result.needsReview.length,
        highestIssued: result.highest,
        highestNumber: result.highestNumber,
        needsReview: result.needsReview,
        counterWas: current,
        counterNow: raise ? target : current,
        raised: raise,
        // A counter already above every valid document means the next number skips a run of serials.
        gap: current > target ? current - target : 0,
        nextNumber: p.format(Math.max(current, target) + 1),
      });
    }
  }
  return report;
}

/**
 * Lowers a counter that stands above every number its series has actually issued - the one thing seeding never does.
 *
 * WHY THIS EXISTS AT ALL. A counter should only ever go up: lowering one is how a number gets issued twice. But a
 * counter can also be WRONG in the upward direction - raised by a document that was never of the series, so that the
 * next invoice skips eighty-odd serials, which for GST invoices is a compliance problem in its own right. Putting that
 * right is a correction, not a tweak, so it is held to a much stricter standard than anything else here:
 *
 *   ONE TRANSACTION. The check that nothing sits above the target and the write that lowers the counter are the same
 *     atomic step. A concurrent sale either commits first (and the check, or the conditional write, then fails) or
 *     waits; there is no window in which an invoice can be numbered at the old height while the counter is moved.
 *   NOTHING ABOVE THE TARGET. If ANY document in the scope carries a number of this series above `to` - including one
 *     that seeding sets aside as an outlier - the correction is refused and the documents are named. A number that is
 *     on a real document is on paper somewhere, so the counter may never be lowered beneath it.
 *   ONLY LOWER. A target at or above the counter is refused: raising is seedCounters' job, with its own rules.
 *   CONDITIONAL WRITE. The counter is changed only if it still holds the value that was read, so two corrections (or a
 *     correction and a sale) cannot both succeed.
 *   AUDITED. A SETTINGS_COUNTER_CORRECTED entry records the old value, the new one, and WHY - written in the same
 *     transaction, so there is never a correction without its reason on file.
 *
 * `dryRun` reads everything and checks everything but writes nothing. It must be called inside a tenant context.
 */
export async function correctCounter({ orgId, org, series = 'sales', branchId = null, to, reason, actor = 'counter correction script', dryRun = true, now = new Date() }) {
  const src = SOURCE[series];
  if (!src) throw new Error(`Unknown series "${series}".`);
  if (!dryRun && !String(reason || '').trim()) throw new Error('A counter correction needs a reason: it is a change to the sequence behind real invoice numbers.');

  const tz = orgTimezone(org);
  const startMonth = org?.settings?.fiscalYearStartMonth || 4;
  const labelFor = (date) => financialYearOf(date ? new Date(date) : now, startMonth, tz).label;
  const p = plan({ numbering: org?.settings?.invoice, series, branchId, org, now, tz });

  const run = async (session) => {
    const q = (query) => (session ? query.session(session) : query);
    const counter = await q(Counter.findOne({ organizationId: orgId, key: p.key })).lean();
    const current = counter?.seq || 0;

    const filter = { organizationId: orgId, ...(branchId && src.branchField ? { [src.branchField]: branchId } : {}) };
    if (p.config.resetEveryFinancialYear) filter[src.dateField] = { $gte: p.financialYear.start, $lt: p.financialYear.end };
    const found = await q(src.model().find(filter).select(`${src.field} ${src.dateField}`)).lean();
    const docs = found.map((d) => ({ _id: d._id, number: d[src.field], date: d[src.dateField] }));

    const classified = classifyForSeeding({ docs, config: p.config, labelFor });
    // EVERY document of this series, outliers included: anything that carries a number of the series is on paper.
    const ofSeries = docs
      .map((d) => ({ ...d, seq: sequenceIfIssuedBy(p.config, d.number, { financialYearLabel: labelFor(d.date) }) }))
      .filter((d) => d.seq !== null);
    const highestOfSeries = ofSeries.reduce((n, d) => Math.max(n, d.seq), 0);
    const target = to === undefined || to === null ? classified.highest : Number(to);

    const report = {
      series,
      key: p.key,
      counterWas: current,
      target,
      highestValid: classified.highest,
      highestOfSeries,
      documents: docs.length,
      needsReview: classified.needsReview.length,
      wouldBeNext: p.format(target + 1),
      aborted: null,
      applied: false,
    };

    if (!Number.isInteger(target) || target < 0) return { ...report, aborted: `"${to}" is not a valid counter value.` };
    if (target >= current) return { ...report, aborted: `The counter (${current}) is not above ${target}, so there is nothing to lower. Raising a counter is seedCounters' job, not this.` };
    const above = ofSeries.filter((d) => d.seq > target).sort((a, b) => a.seq - b.seq);
    if (above.length) {
      return {
        ...report,
        aborted: `${above.length} document(s) of this series carry a number above ${target}, so the counter cannot be lowered beneath them: ${above.slice(0, 5).map((d) => `${d.number} (${d._id})`).join(', ')}${above.length > 5 ? ', …' : ''}.`,
        blockedBy: above.map((d) => ({ _id: String(d._id), number: d.number })),
      };
    }
    if (dryRun) return report;

    // The write only lands if the counter still holds what was read: a sale that numbered something in the meantime
    // moves it, the match fails, and nothing is changed.
    const result = await Counter.updateOne({ organizationId: orgId, key: p.key, seq: current }, { $set: { seq: target } }, { session });
    if (result.matchedCount !== 1) return { ...report, aborted: 'The counter changed while this was being checked, so nothing was written. Run it again.' };

    await AuditLog.create(
      [
        {
          organizationId: orgId,
          userName: actor,
          action: 'SETTINGS_COUNTER_CORRECTED',
          entity: 'Counter',
          message: `${SERIES_LABEL[series]} counter corrected from ${current} to ${target}: ${String(reason).trim()}`,
          meta: { series, key: p.key, from: current, to: target, reason: String(reason).trim(), highestValid: classified.highest, documentsChecked: docs.length, needsReview: classified.needsReview.length },
        },
      ],
      { session },
    );
    return { ...report, applied: true };
  };

  // A dry run reads in the open; a real correction is one transaction from the first read to the audit entry.
  return dryRun ? run(null) : withTransaction(run);
}
