/**
 * Helpers for showing OCR results. Everything shown is what the reading service returned: raw and UNVERIFIED. Nothing here fills a gap, guesses a value
 * or turns uncertain text into a confirmed one; a field the service did not find is shown as "Not found", never as an empty or made-up value.
 */

export const FIELD_GROUPS = [
  {
    title: 'Supplier',
    fields: [
      ['supplierName', 'Name'],
      ['supplierAddress', 'Address'],
      ['supplierGstin', 'GSTIN / tax id'],
      ['supplierPhone', 'Phone'],
      ['supplierEmail', 'Email'],
    ],
  },
  {
    title: 'Invoice',
    fields: [
      ['invoiceNumber', 'Invoice number'],
      ['invoiceDate', 'Invoice date'],
      ['dueDate', 'Due date'],
      ['purchaseOrderNumber', 'PO number'],
    ],
  },
  {
    title: 'Totals',
    fields: [
      ['subtotal', 'Subtotal'],
      ['totalTax', 'Total tax'],
      ['otherCharges', 'Other charges'],
      ['grandTotal', 'Grand total'],
      ['currency', 'Currency'],
    ],
  },
];

/** "92%", or "" when the service gave no confidence. */
export const confidenceLabel = (c) => (typeof c === 'number' && Number.isFinite(c) ? `${Math.round(c * 100)}%` : '');

/** Low means the person should look at the document: under 70%. Unknown is not low. */
export const isLowConfidence = (c) => typeof c === 'number' && c < 0.7;

/** The detected fields in display order, each with what was found or null. */
export function fieldGroups(fields) {
  return FIELD_GROUPS.map((g) => ({
    title: g.title,
    rows: g.fields.map(([key, label]) => {
      const f = fields?.[key];
      return {
        key,
        label,
        found: Boolean(f && f.value),
        value: f?.value ?? null,
        normalized: f?.normalized && f.normalized !== f.value ? f.normalized : null,
        confidence: f?.confidence ?? null,
        pageNumber: f?.pageNumber ?? null,
      };
    }),
  }));
}

/** How many of the known fields were found, for a one-line summary. */
export function fieldCount(fields) {
  const keys = FIELD_GROUPS.flatMap((g) => g.fields.map(([k]) => k));
  return { found: keys.filter((k) => fields?.[k]?.value).length, total: keys.length };
}

/** A table as rows of cells ready to draw: header rows first (flagged), cells keep their spans. A ragged row is padded so the grid stays square. */
export function tableRows(table) {
  const rows = [...(table?.headerRows || []).map((cells) => ({ header: true, cells })), ...(table?.bodyRows || []).map((cells) => ({ header: false, cells }))];
  const width = Math.max(table?.columnCount || 0, ...rows.map((r) => r.cells.reduce((a, c) => a + (c.colSpan || 1), 0)));
  return rows.map((r) => {
    const used = r.cells.reduce((a, c) => a + (c.colSpan || 1), 0);
    return {
      ...r,
      cells: used < width ? [...r.cells, ...Array.from({ length: width - used }, () => ({ text: '', colSpan: 1, rowSpan: 1, confidence: null, padding: true }))] : r.cells,
    };
  });
}

/** A table as tab-separated text, for copying into a spreadsheet. */
export const tableToText = (table) =>
  tableRows(table)
    .map((r) => r.cells.map((c) => c.text.replace(/[\t\n]/g, ' ')).join('\t'))
    .join('\n');

/** The pages with their tables attached, and a short label for each ("Page 2 · 14 lines · 1 table"). */
export function pageViews(ocr) {
  return (ocr?.pages || []).map((p) => {
    const tables = (ocr.tables || []).filter((t) => t.pageNumber === p.pageNumber);
    const lines = p.lines?.length || (p.text ? p.text.split('\n').length : 0);
    return {
      ...p,
      tables,
      label: `Page ${p.pageNumber}`,
      summary: [`${lines} line${lines === 1 ? '' : 's'}`, `${tables.length} table${tables.length === 1 ? '' : 's'}`].join(' · '),
    };
  });
}

/** Warnings that belong to one page ("Page 2 …"), so they can be shown next to it. */
export const warningsForPage = (warnings, pageNumber) => (warnings || []).filter((w) => new RegExp(`^Page ${pageNumber}\\b`).test(w));

/** The state of a scan as one of the four the person sees: Uploaded, Processing, Completed, Failed. Anything later (a draft saved) still counts as Completed. */
export function scanState(upload) {
  const s = upload?.status;
  if (s === 'processing') return 'processing';
  if (s === 'failed') return 'failed';
  if (s === 'completed' || s === 'drafted') return 'completed';
  return 'uploaded';
}
export const SCAN_STATE_LABEL = { uploaded: 'Uploaded', processing: 'Processing', completed: 'Completed', failed: 'Failed' };
