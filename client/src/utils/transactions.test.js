import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeChips, amountNote, columnPlan, directionOf, originOf, summaryLines } from './transactions.js';

const row = (over = {}) => ({ type: 'sale', reference: 'INV-0001', secondary: null, countsAsTrade: true, ...over });

describe('where the document behind a row lives', () => {
  it('takes the reader to the original, searched by its own reference', () => {
    assert.deepEqual(originOf(row()), { path: '/invoices?search=INV-0001', label: 'Open the original' });
    assert.equal(originOf(row({ type: 'purchase', reference: 'PO-0007' })).path, '/orders?search=PO-0007');
    assert.equal(originOf(row({ type: 'salesReturn', reference: 'SR-0003' })).path, '/sales-returns?search=SR-0003');
    assert.equal(originOf(row({ type: 'transfer', reference: 'TRF-0002' })).path, '/inventory/transfers?search=TRF-0002');
  });

  it('sends a purchase return to the order it reversed, because it has no page of its own', () => {
    const o = originOf(row({ type: 'purchaseReturn', reference: 'GRN-0004', secondary: 'PO-0007' }));
    assert.equal(o.path, '/orders?search=PO-0007');
    assert.equal(o.label, 'Open the order it reversed');
  });

  it('offers no link when there is nothing to open', () => {
    assert.equal(originOf(row({ type: 'purchaseReturn', secondary: null })), null);
    assert.equal(originOf(row({ type: 'something-else' })), null);
    assert.equal(originOf(null), null);
  });

  it('escapes a reference so a slash or a space cannot break the link', () => {
    assert.equal(originOf(row({ reference: 'INV/2026 01' })).path, '/invoices?search=INV%2F2026%2001');
  });
});

describe('what the money column says', () => {
  it('says nothing extra about an ordinary trade', () => {
    assert.equal(amountNote(row()), null);
  });

  it('warns that a transfer is not trade, and why its value is shown at all', () => {
    assert.match(amountNote(row({ type: 'transfer', countsAsTrade: false })), /Never a sale or a purchase/);
  });

  it('says plainly when a document is not counted, so nobody adds it up', () => {
    assert.match(amountNote(row({ countsAsTrade: false })), /not counted in any total/);
  });
});

describe('which way the money went', () => {
  it('reads a sale and a reversed purchase as money coming in', () => {
    assert.equal(directionOf('sale'), 'in');
    assert.equal(directionOf('purchaseReturn'), 'in');
  });

  it('reads a purchase and a customer return as money going out', () => {
    assert.equal(directionOf('purchase'), 'out');
    assert.equal(directionOf('salesReturn'), 'out');
  });

  it('reads a transfer as neither', () => {
    assert.equal(directionOf('transfer'), 'none');
  });
});

describe('the filters a reader has set', () => {
  const options = {
    types: [{ value: 'sale', label: 'Sale' }],
    statuses: [{ value: 'refund_pending', label: 'Refund pending' }],
  };

  it('shows one chip per filter, in readable words', () => {
    const chips = activeChips({ type: 'sale', status: 'refund_pending', paymentMode: 'UPI', search: 'Anita', branchId: 'b1' }, { options, branchName: 'North Store' });
    assert.deepEqual(
      chips.map((c) => [c.key, c.value]),
      [
        ['type', 'Sale'],
        ['status', 'Refund pending'],
        ['paymentMode', 'UPI'],
        ['search', 'Anita'],
        ['branchId', 'North Store'],
      ],
    );
  });

  it('shows nothing when nothing has been narrowed', () => {
    assert.deepEqual(activeChips({ type: null, status: null, paymentMode: null, search: null, branchId: null }), []);
    assert.deepEqual(activeChips(null), []);
  });

  it('falls back to the raw value when it has no label for it', () => {
    assert.equal(activeChips({ status: 'in_transit' }, { options })[0].value, 'in_transit');
  });
});

describe('the summary bar', () => {
  const data = {
    total: 12,
    totals: { netSales: 4000, netPurchases: 1500 },
    summary: [
      { type: 'sale', count: 6, counted: 5, amount: 4500 },
      { type: 'purchase', count: 3, counted: 3, amount: 1500 },
      { type: 'salesReturn', count: 2, counted: 2, amount: 500 },
      { type: 'purchaseReturn', count: 0, counted: 0, amount: 0 },
      { type: 'transfer', count: 1, counted: 0, amount: 0 },
    ],
  };

  it('gives each side on its own, because sales and purchases run opposite ways', () => {
    const lines = summaryLines(data);
    assert.deepEqual(lines.map((l) => l.key), ['documents', 'netSales', 'netPurchases', 'transfers']);
    assert.equal(lines[0].value, 12);
    assert.equal(lines[1].value, 4000);
    assert.equal(lines[2].value, 1500);
    assert.equal(lines[3].value, 1, 'transfers are counted, never added to the money');
  });

  it('says what each side is made of', () => {
    const lines = summaryLines(data);
    assert.equal(lines[1].hint, '5 sales less 2 returns.');
    assert.equal(lines[2].hint, '3 orders less 0 reversals.');
  });

  it('has nothing to say before the report has loaded', () => {
    assert.deepEqual(summaryLines(null), []);
  });

  it('reads an empty report as zeroes rather than failing', () => {
    const lines = summaryLines({ total: 0, totals: {}, summary: [] });
    assert.deepEqual(lines.map((l) => l.value), [0, 0, 0, 0]);
  });
});

describe('which columns earn their place', () => {
  it('shows everything when no kind has been chosen', () => {
    const p = columnPlan('');
    assert.equal(p.showType, true);
    assert.equal(p.showParty, true);
    assert.equal(p.showTax, true);
    assert.equal(p.partyHeader, 'Customer / Supplier');
  });

  it('drops the type column once one kind is chosen, because the heading already says it', () => {
    assert.equal(columnPlan('sale').showType, false);
  });

  it('names the party in the chosen kind’s own words', () => {
    assert.equal(columnPlan('sale').partyHeader, 'Customer');
    assert.equal(columnPlan('salesReturn').partyHeader, 'Customer');
    assert.equal(columnPlan('purchase').partyHeader, 'Supplier');
    assert.equal(columnPlan('purchaseReturn').partyHeader, 'Supplier');
  });

  it('hides a column that could only ever be empty', () => {
    assert.equal(columnPlan('sale').showTax, true, 'a sale carries its tax');
    assert.equal(columnPlan('purchase').showTax, true);
    for (const type of ['salesReturn', 'purchaseReturn', 'transfer']) {
      assert.equal(columnPlan(type).showTax, false, `${type} carries no tax breakdown of its own`);
    }
  });

  it('describes a transfer as a route and its money as stock value, never as a party or a sale', () => {
    const p = columnPlan('transfer');
    assert.equal(p.showParty, false);
    assert.equal(p.storeHeader, 'From → To');
    assert.equal(p.amountHeader, 'Stock value');
  });
});
