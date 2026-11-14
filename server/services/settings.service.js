import { Branch, Counter, Invoice, Organization } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { audit } from './audit.service.js';
import { orgTimezone } from './organization.service.js';
import { financialYearOf } from '../utils/financialYear.js';
import { DOCUMENT_SERIES, SERIES_LABEL, plan, seriesConfig, seriesDefaults } from '../utils/documentNumber.js';
import { seedCounters } from './documentNumbering.service.js';
import { INDIAN_STATES, inspectGstin, maskAccountNumber, panFromGstin } from '../utils/indianTax.js';
import { ownsStorageKey, removeOrphanDocuments, sweepAbandonedDocuments } from './settingsFiles.service.js';
import { BUSINESS_CATEGORY_LABEL, DATE_FORMATS, DEFAULT_DATE_FORMAT, GST_REGISTRATION_TYPES, INVOICE_TEMPLATES, LICENSE_TYPES, LICENSE_TYPE_LABEL, PAPER_SIZES, REPORTING_PERIODS } from '../models/Organization.js';

/**
 * Settings: one document, three screens, and two rules that make saving safe.
 *
 * PATCH, NOT PUT. Each screen sends only what the person changed. The service turns that into dotted `$set` paths,
 * so one person editing the bank details cannot wipe another's licence list just because their form did not know
 * about it. An absent field means "not touched"; an empty string means "clear this", and the two are never
 * confused.
 *
 * OPTIMISTIC CONCURRENCY. Every save carries the `updatedAt` the screen last read. The update matches on it, so if
 * somebody else saved in between, the match fails and the caller is told who changed it and when — instead of
 * silently overwriting work that is already in the database. There is no lock to forget to release and no window
 * where two saves can interleave: the check and the write are one atomic operation.
 *
 * EVERY SAVE IS AUDITED WITH A FIELD-LEVEL DIFF — the old value and the new one for each path that actually moved.
 * "Settings updated" tells nobody anything six months later; "gstin: '' → 27AAPFU0939F1ZV" does.
 */

/* ------------------------------------------------------------------ the financial year, and when it may be changed */

/**
 * Whether the start of the financial year can still be changed.
 *
 * It cannot, once any invoice exists in the CURRENT financial year. The start month decides which year every
 * document belongs to - and so which counter an invoice number comes from, which year's sequence it continues, and
 * where a yearly reset begins. Moving it half way through a year would put some of this year's invoices in a year that
 * no longer exists, and the next one in a sequence that has already been used. So it is read-only from the first
 * invoice, with the reason shown, instead of being allowed and quietly corrupting the numbering.
 */
export async function fiscalYearLock(org) {
  const tz = orgTimezone(org);
  const startMonth = org.settings?.fiscalYearStartMonth ?? 4;
  const fy = financialYearOf(new Date(), startMonth, tz);
  const invoices = await Invoice.countDocuments({ organizationId: org._id, invoiceDate: { $gte: fy.start, $lt: fy.end } });
  return {
    startMonth,
    label: fy.label,
    locked: invoices > 0,
    invoicesThisYear: invoices,
    reason:
      invoices > 0
        ? `${invoices.toLocaleString('en-IN')} invoice${invoices === 1 ? ' has' : 's have'} already been issued in the financial year ${fy.label}. Changing when the year starts now would put some of them in a year that no longer exists and let the next number repeat one already used.`
        : null,
  };
}

/**
 * Whether the timezone can still be changed - under exactly the same rule as the financial-year start, and for the same
 * reason. The timezone decides where LOCAL MIDNIGHT falls, and that is what decides which day - and on 1 April which
 * financial year - an invoice belongs to. Moving it half way through a year could carry a sale across a year boundary
 * and into a different numbering series, so it is read-only from the first invoice of the current financial year.
 */
export async function timezoneLock(org) {
  const lock = await fiscalYearLock(org);
  return {
    timezone: orgTimezone(org),
    label: lock.label,
    locked: lock.locked,
    invoicesThisYear: lock.invoicesThisYear,
    reason: lock.locked
      ? `${lock.invoicesThisYear.toLocaleString('en-IN')} invoice${lock.invoicesThisYear === 1 ? ' has' : 's have'} already been issued in the financial year ${lock.label}. The timezone decides where local midnight falls, so changing it now could move a sale across a financial-year boundary and into a different numbering series.`
      : null,
  };
}

/** Refuses to change the timezone once it is locked. Used by every route that can change it. */
export async function assertTimezoneUnlocked(org, newTimezone) {
  if (newTimezone === undefined || newTimezone === null || newTimezone === '') return;
  if (String(newTimezone) === orgTimezone(org)) return; // not a change
  const lock = await timezoneLock(org);
  if (lock.locked) throw new ApiError(409, lock.reason, [{ path: 'timezone', message: 'Locked: invoices exist this financial year' }], 'TIMEZONE_LOCKED');
}

/** Refuses to move the financial-year start once it is locked. Used by every route that can change it. */
export async function assertFiscalYearUnlocked(org, newMonth) {
  if (newMonth === undefined || newMonth === null) return;
  const current = org.settings?.fiscalYearStartMonth ?? 4;
  if (Number(newMonth) === Number(current)) return; // not a change
  const lock = await fiscalYearLock(org);
  if (lock.locked) throw new ApiError(409, lock.reason, [{ path: 'fiscalYearStartMonth', message: 'Locked: invoices exist this financial year' }], 'FISCAL_YEAR_LOCKED');
}

/* ------------------------------------------------------------------ reading */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** A nested patch as dotted paths, so a partial save never replaces a whole sub-document. */
function toPaths(patch, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) toPaths(v, path, out);
    else out[path] = v;
  }
  return out;
}

/** The value at a dotted path, for the before-and-after of the diff. */
const at = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

/** Whether two stored values are the same as far as a person reading an audit entry is concerned. */
function same(a, b) {
  if (a instanceof Date || b instanceof Date) return new Date(a ?? 0).getTime() === new Date(b ?? 0).getTime();
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  // Objects must be compared by their contents. Falling through to String() here would turn every object into
  // "[object Object]", make every object look unchanged, and silently drop the save — which is exactly what it did
  // the first time this was written.
  if (isObject(a) || isObject(b)) return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  return String(a) === String(b);
}

/** Only the paths that actually changed, each with what it was and what it became. */
function diffOf(current, paths) {
  const changes = [];
  for (const [path, next] of Object.entries(paths)) {
    const before = at(current, path);
    if (!same(before, next)) changes.push({ field: path, from: before === undefined ? null : before, to: next });
  }
  return changes;
}

/** A licence with the dates a screen needs to colour it, worked out once here rather than in two places. */
function readLicense(l, warningDays, now) {
  const until = l.validUntil ? new Date(l.validUntil) : null;
  const days = until ? Math.ceil((until.getTime() - now.getTime()) / 86400000) : null;
  return {
    type: l.type,
    typeLabel: LICENSE_TYPE_LABEL[l.type] || l.type,
    number: l.number,
    issuedBy: l.issuedBy || '',
    validFrom: l.validFrom || null,
    validUntil: l.validUntil || null,
    notes: l.notes || '',
    document: l.document?.storageKey ? { fileName: l.document.fileName, mimeType: l.document.mimeType, size: l.document.size } : null,
    daysToExpiry: days,
    status: days === null ? 'no_expiry' : days < 0 ? 'expired' : days <= warningDays ? 'expiring' : 'valid',
  };
}

/**
 * Everything all three tabs need, in one response — the screens are tabs of one document, so one request is both
 * fewer round trips and impossible to get half-stale.
 *
 * `canManage` decides whether the bank account number comes back whole. `settings:read` is held by almost everyone
 * who can sign in, and an account number is not something every member of staff needs; it is masked for anyone who
 * cannot edit it, and the response says it is masked rather than pretending that is the value.
 */
export async function getSettings(org, { canManage = false } = {}) {
  const now = new Date();
  const tz = orgTimezone(org);
  const s = org.settings || {};
  const warningDays = s.general?.licenseExpiryWarningDays ?? 60;
  const licenses = (org.licenses || []).map((l) => readLicense(l, warningDays, now));
  const gstinCheck = inspectGstin(org.gstin, org.address?.state);
  const branches = await Branch.find({ organizationId: org._id, status: 'active' }).select('name code isDefault').sort({ name: 1 }).lean();

  return {
    version: org.updatedAt?.toISOString() || new Date(0).toISOString(),
    updatedAt: s.updatedAt || org.updatedAt || null,
    updatedBy: s.updatedByName || null,
    permissions: { manage: canManage },

    organization: {
      name: org.name,
      slug: org.slug,
      legalName: org.legalName || '',
      businessCategory: org.businessCategory || 'retail',
      description: org.description || '',
      establishedYear: org.establishedYear ?? null,
      email: org.email || '',
      phone: org.phone || '',
      timezone: tz,
      gstin: org.gstin || '',
      gstinWarning: gstinCheck.warning || null,
      logo: org.logo || '',
      address: org.address || {},
      billingSameAsRegistered: org.billingSameAsRegistered !== false,
      billingAddress: org.billingAddress || {},
      tax: {
        registrationType: org.tax?.registrationType || 'regular',
        // Derived from the GSTIN and shown read-only, so the two can never disagree.
        pan: panFromGstin(org.gstin) || org.tax?.pan || '',
        fssai: org.tax?.fssai || '',
        cin: org.tax?.cin || '',
      },
      owner: {
        firstName: org.owner?.firstName || '',
        lastName: org.owner?.lastName || '',
        email: org.owner?.email || '',
        phone: org.owner?.phone || '',
        altPhone: org.owner?.altPhone || '',
      },
      bank: {
        accountHolder: org.bank?.accountHolder || '',
        bankName: org.bank?.bankName || '',
        // Whole only for somebody who could change it anyway; everyone else sees the last four digits.
        accountNumber: canManage ? org.bank?.accountNumber || '' : maskAccountNumber(org.bank?.accountNumber),
        accountNumberMasked: !canManage,
        ifsc: org.bank?.ifsc || '',
        branchName: org.bank?.branchName || '',
        upiId: org.bank?.upiId || '',
      },
      licenses,
      licenseAlerts: licenses.filter((l) => l.status === 'expired' || l.status === 'expiring'),
    },

    invoice: {
      perBranch: Boolean(s.invoice?.perBranch),
      // Every series is returned with its settings resolved, so the screen never has to guess what an unset field
      // would do. A branch with no configuration of its own shows the organization's, which is what it follows.
      series: DOCUMENT_SERIES.map((series) => ({
        series,
        label: SERIES_LABEL[series],
        organization: seriesConfig(s.invoice, series, null),
        branches: branches.map((b) => ({
          branchId: String(b._id),
          name: b.name,
          configured: (s.invoice?.series || []).some((x) => x.series === series && String(x.branchId || '') === String(b._id)),
          config: seriesConfig(s.invoice, series, b._id),
        })),
      })),
      template: {
        paperSize: s.invoice?.template?.paperSize || 'A4',
        style: s.invoice?.template?.style || 'classic',
        accentColor: s.invoice?.template?.accentColor || '#0f766e',
        show: { ...(s.invoice?.template?.show || {}) },
      },
      terms: {
        terms: s.invoice?.terms?.terms || '',
        footerNote: s.invoice?.terms?.footerNote || '',
        returnPolicy: s.invoice?.terms?.returnPolicy || '',
        declaration: s.invoice?.terms?.declaration || '',
        signatoryName: s.invoice?.terms?.signatoryName || '',
        signature: s.invoice?.terms?.signature?.storageKey
          ? { fileName: s.invoice.terms.signature.fileName, mimeType: s.invoice.terms.signature.mimeType, size: s.invoice.terms.signature.size }
          : null,
      },
      calculation: {
        pricesIncludeGst: s.invoice?.calculation?.pricesIncludeGst !== false,
        roundOffNearest: s.invoice?.calculation?.roundOffNearest ?? 1,
        itemDiscountBeforeTax: s.invoice?.calculation?.itemDiscountBeforeTax !== false,
      },
    },

    general: {
      timezone: tz,
      timezoneLock: await timezoneLock(org),
      reportingPeriod: s.reportingPeriod || 'fiscal_year',
      fiscalYearStartMonth: s.fiscalYearStartMonth ?? 4,
      financialYear: financialYearOf(now, s.fiscalYearStartMonth ?? 4, tz).label,
      fiscalYear: await fiscalYearLock(org),
      dateFormat: s.general?.dateFormat || DEFAULT_DATE_FORMAT,
      posRoundOff: Boolean(s.posRoundOff),
      transferApprovalRequired: Boolean(s.transferApprovalRequired),
      transferSelfApproval: Boolean(s.transferSelfApproval),
      orderApprovalRequired: Boolean(s.orderApprovalRequired),
      expiry: {
        thresholds: s.expiry?.thresholds || [15, 30, 90],
        velocityWindowDays: s.expiry?.velocityWindowDays ?? 60,
        supplierReturnWindowDays: s.expiry?.supplierReturnWindowDays ?? 90,
        clearanceMaxDiscount: s.expiry?.clearanceMaxDiscount ?? 50,
      },
      inventory: { defaultLowStockThreshold: s.general?.inventory?.defaultLowStockThreshold ?? 10 },
      billing: {
        // Off and zero unless somebody chose otherwise: what billing has always done.
        requireCustomerPhoneOnCredit: Boolean(s.general?.billing?.requireCustomerPhoneOnCredit),
        defaultCreditDays: s.general?.billing?.defaultCreditDays ?? 0,
      },
      licenseExpiryWarningDays: warningDays,
      notifications: s.general?.notifications || {},
    },

    /**
     * Rules this system enforces and no setting can turn off. They are returned so the screen can SHOW them as
     * locked, with the reason — a safety rule people cannot see is one they assume is not there.
     */
    enforced: [
      {
        key: 'fefo',
        label: 'Oldest stock is sold first (FEFO)',
        detail: 'Billing allocates from the batch that expires soonest, in the same atomic update that takes the stock. It is not a preference the counter can override.',
      },
      {
        key: 'expired',
        label: 'Expired batches can never be sold',
        detail: 'The allocation only ever matches batches whose expiry date is still in the future, so an expired lot cannot reach a bill even if somebody scans it.',
      },
      {
        key: 'negativeStock',
        label: 'Stock can never go negative',
        detail: 'Each batch is decremented with a guard in the update itself, so two tills selling the last strip at the same moment cannot both succeed.',
      },
    ],

    options: {
      states: INDIAN_STATES,
      businessCategories: Object.entries(BUSINESS_CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
      gstRegistrationTypes: GST_REGISTRATION_TYPES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
      licenseTypes: LICENSE_TYPES.map((value) => ({ value, label: LICENSE_TYPE_LABEL[value] })),
      paperSizes: PAPER_SIZES.map((value) => ({ value, label: { A4: 'A4', A5: 'A5', thermal80: '3 inch thermal (80 mm)', thermal58: '2 inch thermal (58 mm)' }[value] })),
      templates: INVOICE_TEMPLATES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
      dateFormats: DATE_FORMATS.map((value) => ({ value, label: value })),
      reportingPeriods: REPORTING_PERIODS.map((value) => ({ value, label: value.replace('_', ' ') })),
      branches: branches.map((b) => ({ value: String(b._id), label: b.name, isDefault: Boolean(b.isDefault) })),
      series: DOCUMENT_SERIES.map((value) => ({ value, label: SERIES_LABEL[value] })),
    },
  };
}

/* ------------------------------------------------------------------ saving */

/**
 * Applies a patch under the version the caller last read. Returns the saved settings; throws 409 when somebody else
 * saved first, with their name, so the screen can offer to reload rather than guessing.
 */
async function applyPatch(req, { version, paths, action, message, scope }) {
  const orgId = req.tenant.organizationId;
  const current = await Organization.findById(orgId).lean();
  if (!current) throw new ApiError(404, 'This organization no longer exists.');

  /**
   * Every path being written must exist in the organization schema. Mongoose does not reject an unknown path - it
   * silently drops it - so a typo'd or mislocated field would come back as a successful save that persisted nothing,
   * with an audit entry claiming it did. Failing here turns that silent loss into a loud error the first time the
   * code is exercised, instead of the first time somebody notices their setting never took effect.
   */
  for (const path of Object.keys(paths)) {
    if (Organization.schema.pathType(path) === 'adhocOrUndefined') {
      throw new ApiError(500, `Internal error: "${path}" is not a stored setting, so it was not saved.`, undefined, 'SETTINGS_PATH_UNKNOWN');
    }
  }

  const changes = diffOf(current, paths);
  if (!changes.length) {
    return { settings: await getSettings(current, { canManage: true }), changes: [], unchanged: true };
  }

  const expected = new Date(version);
  const set = {
    ...paths,
    'settings.updatedAt': new Date(),
    'settings.updatedBy': req.user._id,
    'settings.updatedByName': req.user.name,
  };

  let saved;
  try {
    saved = await Organization.findOneAndUpdate({ _id: orgId, updatedAt: expected }, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
  } catch (e) {
    if (e.code === 11000) throw new ApiError(409, 'That GSTIN is already registered to another organization.', undefined, 'DUPLICATE');
    throw e;
  }

  if (!saved) {
    // The document moved on between the screen reading it and this save. Say who, so the person knows whether to
    // reload and redo their change or go and talk to a colleague.
    const who = current.settings?.updatedByName;
    const when = current.settings?.updatedAt || current.updatedAt;
    throw new ApiError(
      409,
      `${who ? `${who} changed these settings` : 'These settings were changed'}${when ? ` at ${new Date(when).toLocaleString('en-IN')}` : ''}. Reload to see their version — saving now would overwrite it.`,
      undefined,
      'SETTINGS_CONFLICT',
    );
  }

  await audit(req, {
    action,
    entity: 'Organization',
    entityId: orgId,
    message: `${message} (${changes.length} field${changes.length === 1 ? '' : 's'})`,
    // The diff is the point of the entry: what it was, what it became, field by field.
    meta: { scope, changes, version: saved.updatedAt },
  });

  return { settings: await getSettings(saved, { canManage: true }), changes, unchanged: false };
}

/** Tab 1. The PAN is written from the GSTIN rather than taken from the request, so they cannot disagree. */
export async function saveOrganization(req, body) {
  const { version, licenses, ...rest } = body;
  await assertTimezoneUnlocked(req.tenant.organization, rest.timezone);
  const paths = Object.fromEntries(Object.entries(toPaths(rest)).map(([k, v]) => [organizationPath(k), v]));
  if (licenses !== undefined) {
    for (const l of licenses) {
      // A licence may only point at a file in this organization's own folder — never at another tenant's.
      if (l.document?.storageKey && !ownsStorageKey(req.tenant.organizationId, l.document.storageKey)) {
        throw new ApiError(400, 'That licence document was not uploaded here. Upload the file again.', [{ path: 'licenses', message: 'Unknown document' }], 'UNKNOWN_DOCUMENT');
      }
    }
    paths.licenses = licenses.map((l) => ({ ...l, validFrom: l.validFrom || null, validUntil: l.validUntil || null, document: l.document || undefined }));
  }
  if (rest.gstin !== undefined) paths['tax.pan'] = panFromGstin(rest.gstin) || '';

  const before = req.tenant.organization?.licenses || [];
  const result = await applyPatch(req, { version, paths, action: 'SETTINGS_ORGANIZATION_UPDATE', message: 'Organization profile updated', scope: 'organization' });

  // Only once the new list is safely stored are the files it no longer refers to removed.
  if (licenses !== undefined && !result.unchanged) {
    await removeOrphanDocuments(req.tenant.organizationId, before, licenses);
    /**
     * And while we are here, sweep uploads that were never attached to anything and are old enough that nobody is
     * still working on them. Doing it on save costs one directory listing and means the store does not accumulate
     * files from abandoned forms without anybody having to remember to run a script.
     */
    await sweepAbandonedDocuments(req.tenant.organizationId, licenses).catch(() => {});
  }
  return result;
}

/**
 * Tab 2. A series' start may never be set below a number that has already been issued: those invoices exist, their
 * numbers are printed, and the unique index would reject the collision anyway — but a clear refusal beats a
 * database error two days later at the till.
 */
export async function saveInvoice(req, body) {
  const { version, series, ...rest } = body;
  const org = req.tenant.organization;
  const paths = {};
  for (const [k, v] of Object.entries(toPaths(rest))) paths[invoicePath(k)] = v;

  if (series !== undefined) {
    for (const entry of series) {
      /**
       * Only a start that somebody actually CHANGED can be an attempt to restart numbering. The screen sends every
       * series on every save, so an untouched `start: 1` arrives beside a counter that has reached ninety — and
       * that is not a request to begin again at one, it is a field nobody edited. Refusing it would make the whole
       * tab unsaveable the moment a single invoice existed. An unchanged start is harmless in any case: the counter
       * is only ever raised, never lowered, so a start below it simply has no effect.
       */
      const storedStart = seriesConfig(org.settings?.invoice, entry.series, entry.branchId || null).start ?? 1;
      const startChanged = entry.start !== undefined && Number(entry.start) !== Number(storedStart);
      const issued = startChanged ? await issuedCount(org, entry.series, entry.branchId || null) : null;
      if (startChanged && issued && entry.start <= issued.lastSeq) {
        throw new ApiError(
          400,
          `${SERIES_LABEL[entry.series]} numbering cannot start at ${entry.start}: ${issued.lastSeq} has already been issued${issued.lastNumber ? ` (${issued.lastNumber})` : ''}. Numbers that are already on documents can never be reused.`,
          [{ path: 'start', message: `Start at ${issued.lastSeq + 1} or higher` }],
          'NUMBER_ALREADY_ISSUED',
        );
      }
    }
    paths['settings.invoice.series'] = series.map((e) => ({ ...seriesDefaults(e.series), ...e, branchId: e.branchId || null }));
  }
  const result = await applyPatch(req, { version, paths, action: 'SETTINGS_INVOICE_UPDATE', message: 'Invoice settings updated', scope: 'invoice' });

  /**
   * Turning on per-branch numbering, or a yearly reset, makes the next invoice read a counter that has never
   * existed — and a counter that has never existed starts at zero. Unless the printed format changed too, that
   * would re-issue numbers already on paper. Every counter the new configuration can reach is therefore raised
   * now, to the highest number that scope has actually issued, before a single document can be numbered from it.
   */
  if (!result.unchanged) {
    const saved = await Organization.findById(req.tenant.organizationId).lean();
    const branches = await Branch.find({ organizationId: req.tenant.organizationId }).select('name').lean();
    const seeded = await seedCounters({ orgId: req.tenant.organizationId, org: saved, branches });
    const raised = seeded.filter((r) => r.raised);
    if (raised.length) {
      await audit(req, {
        action: 'SETTINGS_COUNTERS_SEEDED',
        entity: 'Organization',
        entityId: req.tenant.organizationId,
        message: `${raised.length} numbering counter(s) raised so the new settings cannot re-issue an existing number`,
        meta: { changes: raised.map((r) => ({ field: r.key, from: r.counterWas, to: r.counterNow })) },
      });
    }
    result.counters = seeded;
  }
  return result;
}

/** Tab 3. The expiry block is edited in place — there is one set of those numbers, not a copy. */
export async function saveGeneral(req, body) {
  const { version, timezone, ...rest } = body;
  await assertFiscalYearUnlocked(req.tenant.organization, rest.fiscalYearStartMonth);
  await assertTimezoneUnlocked(req.tenant.organization, timezone);
  const paths = {};
  if (timezone !== undefined) paths.timezone = timezone; // the timezone lives on the organization, not in settings
  for (const [k, v] of Object.entries(toPaths(rest))) paths[generalFieldPath(k)] = v;
  return applyPatch(req, { version, paths, action: 'SETTINGS_GENERAL_UPDATE', message: 'General settings updated', scope: 'general' });
}

/**
 * Where a Common Settings field is actually stored.
 *
 * Some of them predate the Settings screens and live directly under `settings` (the expiry thresholds, rounding, the
 * approval switches, the reporting period); everything the Common Settings tab added lives under `settings.general`.
 * Writing a field to the wrong place is not an error - Mongoose silently drops a path its schema does not have - so a
 * save would answer 200, report "1 change saved", and persist nothing. That is exactly what this used to do for every
 * `general` field, and it is why the map below is explicit and is checked against the schema by a test.
 */
/**
 * Where each Settings route stores a field. Every route builds its `$set` paths through one of these, and the test that
 * checks the validators against the schema walks the SAME functions - so a field cannot be added to a validator, saved
 * to the wrong place, and have the check pass because it was looking somewhere else.
 *
 *   organization  fields live directly on the organization document
 *   invoice       everything lives under settings.invoice
 *   general       see generalPath below; `timezone` is on the organization itself, not in settings
 */
export const organizationPath = (dotted) => dotted;
export const invoicePath = (dotted) => `settings.invoice.${dotted}`;
export const generalFieldPath = (dotted) => (dotted === 'timezone' ? 'timezone' : generalPath(dotted));

const TOP_LEVEL_SETTINGS = ['reportingPeriod', 'fiscalYearStartMonth', 'posRoundOff', 'transferApprovalRequired', 'transferSelfApproval', 'orderApprovalRequired', 'expiry'];
export const generalPath = (dotted) => {
  const head = dotted.split('.')[0];
  return TOP_LEVEL_SETTINGS.includes(head) ? `settings.${dotted}` : `settings.general.${dotted}`;
};

/**
 * Puts the invoice LAYOUT and its toggles back to the defaults: paper size, template, accent colour, the print
 * toggles, and the calculation choices.
 *
 * It deliberately touches nothing else. The numbering formats, the per-store switch, the terms somebody wrote - and
 * above all the COUNTERS and every number already issued - are not layout. A "reset" button that could also reach
 * the sequence behind the invoice numbers would be one click from a repeated number, so it is not allowed to.
 */
export async function resetInvoice(req, { version }) {
  /**
   * Every default is written out in full. A `$set` of a nested object does NOT bring the schema's defaults with it,
   * so setting `template: { show: {} }` would leave the print toggles empty - and an empty toggle reads as "off",
   * which would quietly turn the whole invoice layout off in the name of resetting it.
   */
  const paths = {
    'settings.invoice.template': {
      paperSize: 'A4',
      style: 'classic',
      accentColor: '#0f766e',
      show: {
        logo: true,
        gstin: true,
        drugLicenses: true,
        hsn: true,
        batchExpiry: true,
        mrp: true,
        discount: true,
        taxBreakup: true,
        amountInWords: true,
        bankDetails: false,
        upiQr: false,
        signature: true,
        computerGenerated: true,
      },
    },
    'settings.invoice.calculation': { pricesIncludeGst: true, roundOffNearest: 1, itemDiscountBeforeTax: true },
  };
  return applyPatch(req, { version, paths, action: 'SETTINGS_INVOICE_RESET', message: 'Invoice layout reset to defaults', scope: 'invoice' });
}

/* ------------------------------------------------------------------ the next number */

/** The highest sequence this series has actually issued, from its counter. */
async function issuedCount(org, series, branchId) {
  const p = plan({ numbering: org.settings?.invoice, series, branchId, org, tz: orgTimezone(org) });
  const counter = await Counter.findOne({ organizationId: org._id, key: p.key }).lean();
  if (!counter?.seq) return null;
  return { lastSeq: counter.seq, lastNumber: p.format(counter.seq) };
}

/**
 * What the next document number will be, without issuing it. This reads the counter and never increments it, so
 * opening the settings screen cannot burn a number — the gap it would leave is exactly the kind of thing an auditor
 * asks about.
 */
export async function previewNumber(org, { series, branchId }) {
  const tz = orgTimezone(org);
  const p = plan({ numbering: org.settings?.invoice, series, branchId: branchId || null, org, tz });
  const counter = await Counter.findOne({ organizationId: org._id, key: p.key }).lean();
  const next = Math.max((counter?.seq || 0) + 1, p.config.start || 1);
  return {
    series,
    label: SERIES_LABEL[series],
    branchId: branchId || null,
    perBranch: p.perBranch,
    counterKey: p.key,
    financialYear: p.config.includeFinancialYear ? p.financialYear.label : null,
    lastIssued: counter?.seq ? p.format(counter.seq) : null,
    next: p.format(next),
    nextSequence: next,
    /** What the first number of the next financial year will look like, when the series resets. */
    afterFinancialYearRollover: p.config.resetEveryFinancialYear
      ? plan({ numbering: org.settings?.invoice, series, branchId: branchId || null, org, now: p.financialYear.end, tz }).format(p.config.start || 1)
      : null,
  };
}
