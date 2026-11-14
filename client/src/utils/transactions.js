/**
 * The Daily Transaction Report: how a row is described, and where the document behind it lives.
 * Nothing here recalculates a business figure — the server works every number out — it only decides how to say it
 * and where "open the original" should go.
 */

/** The accent each kind of document carries, so a list of five kinds can be read at a glance. */
export const TYPE_TONE = {
  sale: 'success',
  purchase: 'info',
  salesReturn: 'warning',
  purchaseReturn: 'orange',
  transfer: 'purple',
};

/**
 * Where the document behind a row actually lives. Each list page accepts `?search=`, so the reference takes the
 * reader straight to it. A purchase return has no page of its own — it is an event on the order it reversed — so it
 * points at that order.
 */
export function originOf(row) {
  if (!row) return null;
  const to = (path, term) => ({ path: `${path}?search=${encodeURIComponent(term)}`, label: 'Open the original' });
  switch (row.type) {
    case 'sale':
      return to('/invoices', row.reference);
    case 'purchase':
      return to('/orders', row.reference);
    case 'salesReturn':
      return to('/sales-returns', row.reference);
    case 'purchaseReturn':
      return row.secondary ? { ...to('/orders', row.secondary), label: 'Open the order it reversed' } : null;
    case 'transfer':
      return to('/inventory/transfers', row.reference);
    default:
      return null;
  }
}

/**
 * The money column, in words. A figure that is not trade (a cancelled invoice, a transfer between our own stores) is
 * still shown — it happened — but it is said plainly that it is not counted, so a reader never adds it up by mistake.
 */
export function amountNote(row) {
  if (!row) return null;
  if (row.type === 'transfer') return 'Stock moved between your own stores, valued at what it cost. Never a sale or a purchase.';
  if (!row.countsAsTrade) return 'This document is not counted in any total.';
  return null;
}

/** Which way the money went, from the business's point of view: in, out, or neither. */
export const directionOf = (type) =>
  type === 'sale' || type === 'purchaseReturn' ? 'in' : type === 'purchase' || type === 'salesReturn' ? 'out' : 'none';

/** The filters a reader actually set, as chips they can take off one at a time. */
export function activeChips(filters, { options, branchName } = {}) {
  if (!filters) return [];
  const label = (list, value) => options?.[list]?.find((o) => o.value === value)?.label || value;
  const chips = [];
  if (filters.type) chips.push({ key: 'type', label: 'Type', value: label('types', filters.type) });
  if (filters.status) chips.push({ key: 'status', label: 'Status', value: label('statuses', filters.status) });
  if (filters.paymentMode) chips.push({ key: 'paymentMode', label: 'Payment', value: filters.paymentMode });
  if (filters.search) chips.push({ key: 'search', label: 'Search', value: filters.search });
  if (filters.branchId) chips.push({ key: 'branchId', label: 'Store', value: branchName || 'One store' });
  return chips;
}

/**
 * What the summary bar says. Sales and purchases run in opposite directions, so there is no single "total" worth
 * printing; each side is given on its own, already net of what came back.
 */
export function summaryLines(data) {
  if (!data) return [];
  const of = (type) => data.summary?.find((s) => s.type === type);
  const sale = of('sale');
  const purchase = of('purchase');
  const salesReturn = of('salesReturn');
  const purchaseReturn = of('purchaseReturn');
  return [
    { key: 'documents', label: 'Transactions', value: data.total || 0, format: 'number', hint: 'Documents matching these filters.' },
    { key: 'netSales', label: 'Net sales', value: data.totals?.netSales || 0, hint: `${sale?.counted || 0} sales less ${salesReturn?.counted || 0} returns.` },
    { key: 'netPurchases', label: 'Net purchases', value: data.totals?.netPurchases || 0, hint: `${purchase?.counted || 0} orders less ${purchaseReturn?.counted || 0} reversals.` },
    { key: 'transfers', label: 'Stock transfers', value: of('transfer')?.count || 0, format: 'number', hint: 'Movements between your own stores. Not trade.' },
  ];
}

/**
 * Which columns earn their place, given the kind of document being looked at. A column that can only ever be empty
 * is worse than no column: it reads as missing data. So when one kind is chosen, the table drops what that kind
 * never carries and names the rest in that kind's own words.
 */
export function columnPlan(type) {
  const plan = {
    showType: !type, // with one kind chosen it is in the heading and the chip already
    showParty: type !== 'transfer', // a transfer's "party" is always ourselves
    showTax: !['salesReturn', 'purchaseReturn', 'transfer'].includes(type), // these carry no tax breakdown of their own
    partyHeader: 'Customer / Supplier',
    storeHeader: 'Store',
    amountHeader: 'Amount',
  };
  if (type === 'sale' || type === 'salesReturn') plan.partyHeader = 'Customer';
  if (type === 'purchase' || type === 'purchaseReturn') plan.partyHeader = 'Supplier';
  if (type === 'transfer') {
    plan.storeHeader = 'From → To';
    plan.amountHeader = 'Stock value';
  }
  return plan;
}
