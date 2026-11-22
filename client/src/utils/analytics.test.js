import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIX_DESTINATIONS, bucketLabel, compactMoney, dayString, mixAccessibleName, quickRange, trendOf } from './analytics.js';

// A fixed instant so the ranges can be checked exactly: Monday 9 November 2026, mid-morning.
const NOW = new Date(2026, 10, 9, 10, 30);

describe('the ranges people ask for', () => {
  it('reads today and yesterday as single days', () => {
    assert.deepEqual(quickRange('today', NOW), { from: '2026-11-09', to: '2026-11-09' });
    assert.deepEqual(quickRange('yesterday', NOW), { from: '2026-11-08', to: '2026-11-08' });
  });

  it('counts the last 7 and 30 days inclusive of today', () => {
    assert.deepEqual(quickRange('last7', NOW), { from: '2026-11-03', to: '2026-11-09' }, 'seven days including today');
    assert.deepEqual(quickRange('last30', NOW), { from: '2026-10-11', to: '2026-11-09' });
  });

  it('stops this month, quarter and year at today rather than at a date that has not happened', () => {
    assert.deepEqual(quickRange('thisMonth', NOW), { from: '2026-11-01', to: '2026-11-09' });
    assert.deepEqual(quickRange('thisQuarter', NOW), { from: '2026-10-01', to: '2026-11-09' }, 'October starts the quarter');
    assert.deepEqual(quickRange('thisYear', NOW), { from: '2026-01-01', to: '2026-11-09' });
  });

  it('gives last month its own whole length', () => {
    assert.deepEqual(quickRange('lastMonth', NOW), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(quickRange('lastMonth', new Date(2026, 2, 15)), { from: '2026-02-01', to: '2026-02-28' }, 'and knows how long February is');
  });

  it('hands custom back to the person', () => {
    assert.equal(quickRange('custom', NOW), null);
    assert.equal(quickRange('nonsense', NOW), null);
  });

  it('writes a day the way the API reads it', () => {
    assert.equal(dayString(new Date(2026, 0, 5)), '2026-01-05');
  });
});

describe('money in a small space', () => {
  it('shortens to thousands, lakhs and crores the Indian way', () => {
    assert.equal(compactMoney(980), '₹980');
    assert.equal(compactMoney(1500), '₹1.5K');
    assert.equal(compactMoney(45600), '₹46K');
    assert.equal(compactMoney(125000), '₹1.25L');
    assert.equal(compactMoney(12500000), '₹1.25Cr');
    assert.equal(compactMoney(0), '₹0');
    assert.equal(compactMoney(-1500), '-₹1.5K');
  });
});

describe('what a change means', () => {
  const kpi = (key, percent, extra = {}) => ({ key, change: { percent, direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat', ...extra } });

  it('treats a rise in sales as good and a rise in returns as bad', () => {
    assert.equal(trendOf(kpi('totalSales', 12)).tone, 'up');
    assert.equal(trendOf(kpi('totalSales', -8)).tone, 'down');
    assert.equal(trendOf(kpi('salesReturns', 12)).tone, 'down', 'more coming back is not good news');
    assert.equal(trendOf(kpi('salesReturns', -5)).tone, 'up');
    assert.equal(trendOf(kpi('receivables', 20)).tone, 'down', 'more owed to us is not good news either');
  });

  it('says so plainly when there is nothing to compare with', () => {
    assert.deepEqual(trendOf({ key: 'totalSales', change: { percent: null, isNew: true } }), { label: 'New in this period', tone: 'neutral', direction: 'flat' });
    assert.equal(trendOf(kpi('totalSales', 0)).label, 'No change');
    assert.equal(trendOf({ key: 'totalSales' }).label, 'No change', 'and when the server sent nothing at all');
  });

  it('spells the comparison out', () => {
    assert.equal(trendOf(kpi('totalSales', 12.5)).label, '+12.5% vs previous period');
    assert.equal(trendOf(kpi('totalSales', -4)).label, '-4% vs previous period');
  });
});

describe('chart labels', () => {
  it('reads a bucket the way its length deserves', () => {
    assert.equal(bucketLabel('2026-11-09', 'day'), '09 Nov');
    assert.equal(bucketLabel('2026-11-09', 'week'), '09 Nov');
    assert.equal(bucketLabel('2026-11', 'month'), 'Nov 26');
  });
});

describe('the Transaction breakdown: where a row leads, and what it is called', () => {
  const row = (key, label) => ({ key, label, count: 12 });

  it('names the report each row really opens', () => {
    assert.equal(mixAccessibleName(row('sales', 'Sales'), '₹4,000'), 'Sales: 12 transactions worth ₹4,000. Open the Sales Report.');
    assert.equal(mixAccessibleName(row('purchases', 'Purchases'), '₹2,500'), 'Purchases: 12 transactions worth ₹2,500. Open the Purchase Report.');
    assert.match(mixAccessibleName(row('salesReturns', 'Sales returns'), '₹100'), /Open the transaction report\.$/);
    assert.match(mixAccessibleName(row('purchaseReturns', 'Purchase returns'), '₹100'), /Open the transaction report\.$/);
  });

  it('only the rows that really open the transaction report say so, and they carry the filter', () => {
    for (const [key, dest] of Object.entries(MIX_DESTINATIONS)) {
      const opensTransactions = dest.path === '/analytics/transactions';
      assert.equal(/transaction report/.test(dest.opens), opensTransactions, `${key}: the name and the address disagree`);
      assert.equal(Boolean(dest.type), opensTransactions, `${key}: only the transaction report takes a type filter`);
    }
  });

  it('falls back to the transaction report for a kind it has not heard of, as the link does', () => {
    assert.match(mixAccessibleName(row('mystery', 'Mystery'), '₹1'), /Open the transaction report\.$/);
  });
});
