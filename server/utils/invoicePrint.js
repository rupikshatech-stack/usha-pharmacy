import { roundOffFor } from './billMath.js';

/**
 * What an invoice needs to know about the SELLER, built on the server from the organization itself.
 *
 * A printed invoice must carry the seller's address, GSTIN, licences and (if the organization prints it) bank details, whoever
 * is at the till. That data used to be fetched by the browser from GET /settings, which needs `settings:read` and masks the bank
 * account number: a billing-only user was refused, the print silently fell back to the bare organization name, and the invoice
 * went to the customer without a GSTIN. It describes the seller and is printed for every customer, so it is not a secret from the
 * people who issue the invoices. It travels WITH the invoice instead (see `withPrintBlock`).
 *
 * Only what the template can print is sent, and the bank block only when the template is set to print it.
 */

/** The first two digits of a GSTIN are the state. One rule, used by the server to decide CGST+SGST versus IGST and by the till's preview. */
export const stateOfGstin = (gstin) => String(gstin || '').trim().slice(0, 2);

/**
 * The seller as it is at this moment, in the shape stored on an invoice at sale time. The bank block is kept whole here (whether it
 * is PRINTED is decided at read time by the layout settings); the logo is not, since it is a file the organization may replace.
 */
export function sellerSnapshotOf(org) {
  const address = org?.address || {};
  const bank = org?.bank || {};
  return {
    name: org?.name || '',
    legalName: org?.legalName || '',
    phone: org?.phone || '',
    gstin: org?.gstin || '',
    address: { line1: address.line1 || '', line2: address.line2 || '', landmark: address.landmark || '', city: address.city || '', state: address.state || '', pincode: address.pincode || '' },
    licenses: (org?.licenses || []).map((l) => ({ type: l.type, number: l.number })),
    bank: { accountHolder: bank.accountHolder || '', bankName: bank.bankName || '', accountNumber: bank.accountNumber || '', ifsc: bank.ifsc || '', branchName: bank.branchName || '', upiId: bank.upiId || '' },
  };
}

/**
 * `seller` is the invoice's own snapshot. Layout, terms and logo are presentation, not facts about the sale, so they stay live.
 * An invoice with no snapshot (issued before snapshots existed) falls back to the organization as it is now.
 */
export function printBlockFor(org, seller) {
  const template = org?.settings?.invoice?.template || {};
  const terms = org?.settings?.invoice?.terms || {};
  const show = template.show || {};
  const printsBank = Boolean(show.bankDetails || show.upiQr); // the client template's defaults for both are off
  const s = seller || sellerSnapshotOf(org);

  return {
    organization: {
      name: s.name,
      legalName: s.legalName,
      phone: s.phone,
      gstin: s.gstin,
      logo: org?.logo || '',
      address: s.address,
      licenses: s.licenses,
      ...(printsBank ? { bank: s.bank } : {}),
    },
    settings: {
      template: { paperSize: template.paperSize || 'A4', style: template.style || 'classic', accentColor: template.accentColor || '#0f766e', show: { ...show } },
      terms: { terms: terms.terms || '', footerNote: terms.footerNote || '', returnPolicy: terms.returnPolicy || '', declaration: terms.declaration || '', signatoryName: terms.signatoryName || '' },
    },
  };
}

/** The invoice as a plain object with its `print` block attached and the raw `seller` snapshot removed (it is only ever sent as `print`). */
export function withPrintBlock(invoice, org) {
  const { seller, ...plain } = typeof invoice?.toObject === 'function' ? invoice.toObject() : invoice;
  return { ...plain, print: printBlockFor(org, seller) };
}

/** What the Selling Point's PREVIEW needs before any invoice exists: the seller's state, and whether the bill is rounded. */
export const posContextFor = (org) => ({ sellerState: stateOfGstin(org?.gstin), roundOff: roundOffFor(org?.settings) });
