// The maths behind Inventory Expiry Intelligence, checked on its own. These tests touch no database and no clock:
// every case hands in its own instant, so they say the same thing in January as in June.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUCKETS_AT_LEAST,
  allocateFefo,
  assessBatch,
  bucketOf,
  daysToExpiry,
  riskScoreOf,
  suggestedDiscount,
  supplierReturnable,
  urgencyOf,
  valueWeightOf,
} from '../services/expiryRisk.js';

/** A fixed "today" so every expectation below is arithmetic, not a function of when the suite runs. */
const NOW = new Date('2026-11-10T09:30:00.000Z');
/** An expiry `days` from NOW, stored the way the Batch model stores one: midnight UTC on the day itself. */
const expiryIn = (days) => new Date(Date.UTC(2026, 10, 10 + days));
const lot = (days, quantity, extra = {}) => ({ expiryDate: expiryIn(days), quantity, purchasePrice: 10, mrp: 25, ...extra });

test('daysToExpiry counts whole days and ignores the time of day', () => {
  assert.equal(daysToExpiry(expiryIn(30), NOW), 30);
  assert.equal(daysToExpiry(expiryIn(0), NOW), 0, 'a lot expiring today has nought days left, not minus one');
  assert.equal(daysToExpiry(expiryIn(-5), NOW), -5, 'a lot five days past its date reads as minus five');
  assert.equal(daysToExpiry(null, NOW), null);

  // The same calendar day read at either end of the working day gives the same answer.
  const earlyMorning = new Date('2026-11-10T00:05:00.000Z');
  const lateEvening = new Date('2026-11-10T23:55:00.000Z');
  assert.equal(daysToExpiry(expiryIn(15), earlyMorning), daysToExpiry(expiryIn(15), lateEvening));
});

test('urgency and value weight behave the way the score assumes', () => {
  assert.equal(urgencyOf(0), 1, 'expiring today is as urgent as it gets');
  assert.equal(urgencyOf(-20), 1, 'already expired cannot be more urgent than expiring today');
  assert.equal(urgencyOf(90), 0.5, 'half the horizon away is half as urgent');
  assert.equal(urgencyOf(400), 0, 'beyond the horizon, time is not the problem');

  assert.equal(valueWeightOf(0), 0, 'no money at stake carries no weight');
  assert.equal(valueWeightOf(100000), 1, 'a lakh of projected loss saturates the scale');
  assert.ok(valueWeightOf(5000) > valueWeightOf(500), 'ten times the money weighs more');
  assert.ok(valueWeightOf(210000) <= 1, 'the scale never runs past one');
});

/* ------------------------------------------------------------------ FEFO allocation */

test('FEFO: one lot sells what the demand allows before it expires', () => {
  const [a] = allocateFefo([lot(30, 500)], 10, NOW);
  assert.equal(a.expectedSales, 300, '10 a day for 30 days is 300 units');
  assert.equal(a.projectedUnsoldQty, 200, 'the other 200 will still be on the shelf');
});

test('FEFO: a lot never sells more than it holds', () => {
  const [a] = allocateFefo([lot(90, 50)], 10, NOW);
  assert.equal(a.expectedSales, 50, 'demand is 900 units but there are only 50');
  assert.equal(a.projectedUnsoldQty, 0);
});

test('FEFO: several lots of one medicine share the demand, earliest expiry first', () => {
  // 10/day. The near lot can sell into 30 days (300 units) and holds 100 — it clears.
  // The far lot sees 60 days of demand (600), of which the near lot already took 100, leaving 500; it holds 400.
  const rows = allocateFefo([lot(30, 100), lot(60, 400)], 10, NOW);
  assert.equal(rows[0].expectedSales, 100, 'the lot expiring first is sold first');
  assert.equal(rows[0].projectedUnsoldQty, 0);
  assert.equal(rows[1].expectedSales, 400, 'what is left of the demand goes to the lot behind it');
  assert.equal(rows[1].projectedUnsoldQty, 0);
});

test('FEFO: the lot behind a slow-moving one carries the loss', () => {
  // 1/day. Near lot: 30 days of demand = 30 units, holds 100 → 70 unsold.
  // Far lot: 60 days of demand = 60, minus the 30 already sold = 30 available, holds 100 → 70 unsold.
  const rows = allocateFefo([lot(30, 100), lot(60, 100)], 1, NOW);
  assert.deepEqual(
    rows.map((r) => [r.expectedSales, r.projectedUnsoldQty]),
    [[30, 70], [30, 70]],
  );
});

test('FEFO: the answer does not depend on the order the lots were handed in', () => {
  const inOrder = allocateFefo([lot(30, 100), lot(60, 400)], 10, NOW);
  const shuffled = allocateFefo([lot(60, 400), lot(30, 100)], 10, NOW);
  assert.deepEqual(shuffled[0], inOrder[1], 'each row keeps its own lot, whatever order they arrived in');
  assert.deepEqual(shuffled[1], inOrder[0]);
});

test('FEFO: units left on an expired lot are dead and are not resold by the lot behind it', () => {
  // The expired lot sees no demand at all; its 80 units are gone. The live lot still gets its own full 30 days.
  const rows = allocateFefo([lot(-10, 80), lot(30, 100)], 2, NOW);
  assert.equal(rows[0].expectedSales, 0, 'nothing sells after the date has passed');
  assert.equal(rows[0].projectedUnsoldQty, 80, 'the whole expired lot is a loss');
  assert.equal(rows[1].expectedSales, 60, 'the live lot still sees 2 a day for 30 days');
  assert.equal(rows[1].projectedUnsoldQty, 40);
});

test('FEFO: a brand-new lot is judged on the medicine, not on its own empty history', () => {
  // This is the case that per-batch velocity gets badly wrong: a lot received today, with a long expiry, in a
  // medicine that sells 20 a day. Judged alone it would show a total write-off; judged on the medicine it clears.
  const rows = allocateFefo([lot(365, 2000)], 20, NOW);
  assert.equal(rows[0].projectedUnsoldQty, 0, 'a fast-moving medicine clears a new lot with a year on it');
});

test('FEFO: no sales at all means nothing is expected to sell', () => {
  const rows = allocateFefo([lot(30, 100), lot(90, 50)], 0, NOW);
  assert.deepEqual(rows.map((r) => r.projectedUnsoldQty), [100, 50]);
  assert.deepEqual(rows.map((r) => r.expectedSales), [0, 0]);
});

test('FEFO: an empty lot projects no loss and takes none of the demand', () => {
  const rows = allocateFefo([lot(10, 0), lot(60, 300)], 5, NOW);
  assert.equal(rows[0].expectedSales, 0);
  assert.equal(rows[0].projectedUnsoldQty, 0, 'nothing on hand cannot go unsold');
  assert.equal(rows[1].expectedSales, 300, 'the empty lot does not eat into the demand behind it');
});

test('FEFO: no lots at all is not an error', () => {
  assert.deepEqual(allocateFefo([], 10, NOW), []);
});

test('FEFO: a negative or missing velocity is read as no sales rather than as demand', () => {
  assert.equal(allocateFefo([lot(30, 100)], -5, NOW)[0].projectedUnsoldQty, 100);
  assert.equal(allocateFefo([lot(30, 100)], undefined, NOW)[0].projectedUnsoldQty, 100);
});

/* ------------------------------------------------------------------ the score */

test('an expired lot still holding stock is Critical whatever it is worth', () => {
  const cheap = riskScoreOf({ daysToExpiry: -1, quantity: 1, projectedUnsoldQty: 1, projectedLoss: 2 });
  assert.equal(cheap.level, 'critical', 'it cannot be sold at all, so the money is beside the point');
  assert.equal(cheap.score, 100);
});

test('an expired lot with nothing left on it is not a problem', () => {
  const empty = riskScoreOf({ daysToExpiry: -30, quantity: 0, projectedUnsoldQty: 0, projectedLoss: 0 });
  assert.notEqual(empty.level, 'critical', 'an empty lot that expired is history, not work');
});

test('a lot that will clear itself, comfortably far off, is Safe', () => {
  const r = riskScoreOf({ daysToExpiry: 200, quantity: 500, projectedUnsoldQty: 0, projectedLoss: 0 });
  assert.equal(r.level, 'safe');
  assert.equal(r.score, 0);
});

test('a product that never sells is not urgent while its expiry is years away', () => {
  // The regression this guards: a never-sold lot is projected 100% unsold whatever its date, so counting that at full
  // weight scored a lot TWO YEARS out as a live problem. A register full of those is a register nobody reads.
  const faraway = riskScoreOf({ daysToExpiry: 782, quantity: 10, projectedUnsoldQty: 10, projectedLoss: 0 });
  assert.equal(faraway.level, 'safe', `a lot 782 days out is not this week's work, got ${faraway.level} at ${faraway.score}`);

  // The same lot, as its date comes into view, becomes work.
  const soon = riskScoreOf({ daysToExpiry: 10, quantity: 10, projectedUnsoldQty: 10, projectedLoss: 0 });
  assert.ok(soon.score > faraway.score, 'the same dead stock does matter once the date is close');
  assert.ok(['critical', 'high'].includes(soon.level));
});

test('waste still outranks a lot of the same age that will clear itself', () => {
  const wasted = riskScoreOf({ daysToExpiry: 40, quantity: 100, projectedUnsoldQty: 100, projectedLoss: 1000 });
  const clears = riskScoreOf({ daysToExpiry: 40, quantity: 100, projectedUnsoldQty: 0, projectedLoss: 0 });
  assert.ok(wasted.score > clears.score, 'gating by urgency must not flatten the difference that matters');
});

test('the score rises as the date closes in, all else being equal', () => {
  const at = (days) => riskScoreOf({ daysToExpiry: days, quantity: 100, projectedUnsoldQty: 50, projectedLoss: 500 }).score;
  assert.ok(at(10) > at(45), 'ten days out is worse than forty-five');
  assert.ok(at(45) > at(120), 'and forty-five is worse than four months');
});

test('the score rises with the share projected to go unsold, all else being equal', () => {
  const unsold = (n) => riskScoreOf({ daysToExpiry: 30, quantity: 100, projectedUnsoldQty: n, projectedLoss: n * 10 }).score;
  assert.ok(unsold(90) > unsold(50), 'nearly all of it going to waste beats half of it');
  assert.ok(unsold(50) > unsold(10));
});

test('money breaks a tie between two lots that are otherwise the same', () => {
  const small = riskScoreOf({ daysToExpiry: 30, quantity: 100, projectedUnsoldQty: 50, projectedLoss: 100 });
  const large = riskScoreOf({ daysToExpiry: 30, quantity: 100, projectedUnsoldQty: 50, projectedLoss: 80000 });
  assert.ok(large.score > small.score, 'the same waste of eighty thousand rupees outranks a hundred');
});

test('every score lands in a band, and the bands run the right way', () => {
  for (const days of [-5, 0, 7, 20, 45, 100, 400]) {
    for (const unsold of [0, 25, 100]) {
      const { score, level } = riskScoreOf({ daysToExpiry: days, quantity: 100, projectedUnsoldQty: unsold, projectedLoss: unsold * 12 });
      assert.ok(score >= 0 && score <= 100, `score out of range: ${score}`);
      assert.ok(['critical', 'high', 'medium', 'low', 'safe'].includes(level));
    }
  }
});

/* ------------------------------------------------------------------ buckets, discounts, supplier returns */

test('a lot belongs to exactly one bucket', () => {
  assert.equal(bucketOf(-1), 'expired');
  assert.equal(bucketOf(0), 'expired', 'the day it expires it is already no use tomorrow');
  assert.equal(bucketOf(15), 'under15', 'the threshold itself is inside the bucket');
  assert.equal(bucketOf(16), 'under30');
  assert.equal(bucketOf(30), 'under30');
  assert.equal(bucketOf(31), 'under90');
  assert.equal(bucketOf(90), 'under90');
  assert.equal(bucketOf(91), 'safe');
  assert.equal(bucketOf(null), 'unknown');
});

test('buckets honour the organization’s own thresholds', () => {
  assert.equal(bucketOf(20, [7, 21, 60]), 'under30', 'twenty days is inside this org’s middle bucket');
  assert.equal(bucketOf(70, [7, 21, 60]), 'safe', 'and seventy is past its longest one');
});

test('clicking a card filters to everything at least that urgent', () => {
  assert.deepEqual(BUCKETS_AT_LEAST.under30, ['expired', 'under15', 'under30']);
  assert.deepEqual(BUCKETS_AT_LEAST.expired, ['expired']);
  assert.deepEqual(BUCKETS_AT_LEAST.safe, ['safe'], 'Safe is its own thing, not "everything at least safe"');
});

test('the suggested discount rises with risk, stops at the ceiling, and lands on a round number', () => {
  assert.equal(suggestedDiscount({ score: 0, projectedUnsoldQty: 0, daysToExpiry: 200 }), 0, 'nothing going to waste needs no discount');
  assert.equal(suggestedDiscount({ score: 90, projectedUnsoldQty: 50, daysToExpiry: -2 }), 0, 'an expired lot cannot be discounted, only disposed of');
  const high = suggestedDiscount({ score: 80, projectedUnsoldQty: 50, daysToExpiry: 10, maxDiscount: 50 });
  const medium = suggestedDiscount({ score: 40, projectedUnsoldQty: 50, daysToExpiry: 60, maxDiscount: 50 });
  assert.ok(high > medium);
  assert.ok(high <= 50, 'it never exceeds the organization’s ceiling');
  assert.equal(high % 5, 0, 'nobody advertises 23% off');
  assert.ok(suggestedDiscount({ score: 90, projectedUnsoldQty: 50, daysToExpiry: 10, maxDiscount: 20 }) <= 20);
});

test('stock is only recoverable from a supplier when there is a supplier and the date is close enough', () => {
  const base = { supplierId: 'sup1', daysToExpiry: 30, windowDays: 90 };
  assert.equal(supplierReturnable(base), true);
  assert.equal(supplierReturnable({ ...base, daysToExpiry: -40 }), true, 'distributors take back recently expired stock too');
  assert.equal(supplierReturnable({ ...base, daysToExpiry: 200 }), false, 'a lot nowhere near its date is not a return, it is just stock');
  assert.equal(supplierReturnable({ ...base, supplierId: null }), false, 'with no supplier recorded there is nobody to send it to');
  assert.equal(supplierReturnable({ ...base, disposedAt: new Date() }), false, 'it has already been written off');
  assert.equal(supplierReturnable({ ...base, supplierReturnStatus: 'returned' }), false, 'it has already gone back');
  assert.equal(supplierReturnable({ ...base, supplierReturnStatus: 'rejected' }), true, 'a refusal can be appealed or the lot sent elsewhere');
});

/* ------------------------------------------------------------------ one whole row */

test('assessBatch puts the whole picture together for one lot', () => {
  const batch = { quantity: 100, purchasePrice: 12, mrp: 30, supplierId: 'sup1', expiryDate: expiryIn(20) };
  const allocation = allocateFefo([{ ...batch }], 1, NOW)[0];
  const row = assessBatch(batch, { ...allocation, avgDailySales: 1 }, { supplierReturnWindowDays: 90, clearanceMaxDiscount: 50 });

  assert.equal(row.daysToExpiry, 20);
  assert.equal(row.projectedUnsoldQty, 80, '1 a day for 20 days clears 20 of the 100');
  assert.equal(row.projectedLoss, 960, '80 units at the ₹12 they cost');
  assert.equal(row.costValue, 1200, 'the whole lot at cost');
  assert.equal(row.mrpValue, 3000, 'and at what it would retail for');
  assert.equal(row.bucket, 'under30');
  assert.equal(row.recoverable, true);
  assert.ok(row.riskScore > 0 && row.riskScore <= 100);
  assert.ok(['critical', 'high', 'medium', 'low'].includes(row.riskLevel));
});

test('assessBatch values an empty lot at nothing rather than dividing by zero', () => {
  const batch = { quantity: 0, purchasePrice: 12, mrp: 30, expiryDate: expiryIn(5) };
  const row = assessBatch(batch, allocateFefo([batch], 3, NOW)[0], {});
  assert.equal(row.projectedLoss, 0);
  assert.equal(row.costValue, 0);
  assert.equal(row.mrpValue, 0);
});
