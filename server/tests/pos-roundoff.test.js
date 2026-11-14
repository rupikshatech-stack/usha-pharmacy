// The Selling Point's cart total and the invoice that gets saved for the same cart must be the same number.
//
// The cart does its own arithmetic in the browser so the cashier sees a total before pressing Save. That is only
// honest if it is the SAME arithmetic the server applies - and for a long time it was not: the server rounds the bill
// when an organization asks it to, and the cart did not, so with rounding on the screen said ₹99.30 while the printed
// invoice said ₹99.00. This test puts one cart through both and compares.
//
// It imports the client's cart function directly (a pure ES module with no browser dependency), so what is tested is
// the very code the page runs, not a copy of it.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';
import { cartBill } from '../../client/src/utils/cartBill.js';
import { roundOffFor as clientRoundOffFor } from '../../client/src/utils/billMath.js';
import { roundOffFor as serverRoundOffFor } from '../utils/billMath.js';

let h;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `pos-${Date.now()}-${++n}`;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.stop();
});

/**
 * What the Selling Point passes to the cart arithmetic.
 *
 * THIS is the line that was wrong. It used to pass no `roundOff` at all; it now asks `roundOffFor` for the
 * organization's own settings, which is also what the server does. The page fetches the organization once and reads
 * `settings` from it, so that is what is handed here.
 */
const asThePageDoes = (orgSettings, cart, extra = {}) =>
  cartBill({ cart, discount: extra.discount, customerGstin: '', orgState: '', paymentType: extra.paymentType || 'Cash', paid: extra.paid, roundOff: clientRoundOffFor(orgSettings) });

async function tenantWithRounding({ nearest }) {
  const org = await h.makeTenant(`POS Round ${nearest} Org`);
  const cur = (await org.client.get('/settings')).data;
  const a = await org.client.patch('/settings/general', { version: cur.version, posRoundOff: true });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const cur2 = (await org.client.get('/settings')).data;
  const b = await org.client.patch('/settings/invoice', { version: cur2.version, calculation: { roundOffNearest: nearest } });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  return org;
}

async function stock(org, prices) {
  const lines = [];
  for (const price of prices) {
    const med = (await org.client.post('/inventory', { medicineName: uniq('Cart Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
    const made = await org.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: Math.max(price, 500), sellingPrice: price, purchasePrice: 1, initialQuantity: 100 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    lines.push({ medicineId: med._id, price, gstPercent: 12 });
  }
  return lines;
}

/** The cart the cashier built, in the shape the page holds it. */
const asCart = (lines, quantities, discountPercents = []) => lines.map((l, i) => ({ medicineId: l.medicineId, price: l.price, gstPercent: l.gstPercent, quantity: quantities[i], discountPercent: discountPercents[i] || 0 }));

const saveSale = async (org, cart, extra = {}) => {
  const r = await org.client.post('/invoices', {
    items: cart.map((c) => ({ medicineId: c.medicineId, quantity: c.quantity, discountPercent: c.discountPercent })),
    idempotencyKey: key(),
    ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};

describe('The cart and the saved invoice agree', () => {
  for (const nearest of [1, 0.5]) {
    describe(`with rounding to the nearest ₹${nearest}`, () => {
      let org;
      let lines;
      let settings;
      before(async () => {
        org = await tenantWithRounding({ nearest });
        lines = await stock(org, [99.3, 47.45, 212.8, 18.15]);
        settings = (await org.client.get('/organization')).data.settings; // what the page reads
      });

      it('shows the same total, and the same round-off line, as the invoice it saves', async () => {
        for (const quantities of [[1, 0, 0, 0], [1, 2, 0, 3], [3, 1, 1, 1], [2, 2, 2, 2]]) {
          const picked = lines.map((l, i) => ({ l, q: quantities[i] })).filter((x) => x.q > 0);
          const cart = asCart(picked.map((x) => x.l), picked.map((x) => x.q));

          const shown = asThePageDoes(settings, cart);
          const saved = await saveSale(org, cart);

          assert.equal(shown.total, saved.total, `cart ${JSON.stringify(quantities)}: the cart says ${shown.total}, the invoice says ${saved.total}`);
          assert.equal(shown.roundOff, saved.roundOff, `cart ${JSON.stringify(quantities)}: the round-off line differs`);
          assert.equal(shown.taxable, saved.taxableAmount);
          assert.equal(shown.tax, saved.taxTotal);
          assert.equal(shown.due, saved.due);
        }
      });

      it('agrees when a line discount and a bill discount are in play too', async () => {
        const cart = asCart(lines, [2, 1, 3, 2], [10, 0, 5, 0]);
        const discount = { type: 'amount', value: 7 };
        const shown = asThePageDoes(settings, cart, { discount });
        const saved = await saveSale(org, cart, { discount });
        assert.equal(shown.total, saved.total);
        assert.equal(shown.roundOff, saved.roundOff);
        assert.equal(shown.itemDisc, saved.itemDiscount);
        assert.equal(shown.disc, saved.discount);
      });

      it('agrees on a credit sale, where the amount still due is worked from the rounded total', async () => {
        const cart = asCart(lines, [1, 1, 1, 1]);
        const shown = asThePageDoes(settings, cart, { paymentType: 'Credit', paid: 100 });
        const saved = await saveSale(org, cart, { paymentType: 'Credit', paid: 100 });
        assert.equal(shown.total, saved.total);
        assert.equal(shown.due, saved.due);
        assert.equal(shown.paid, saved.paid);
      });

      it('lands on a multiple of the chosen step', async () => {
        const cart = asCart(lines, [1, 1, 1, 1]);
        const shown = asThePageDoes(settings, cart);
        assert.equal(Math.round(shown.total * 100) % Math.round(nearest * 100), 0, `${shown.total} is a multiple of ₹${nearest}`);
      });
    });
  }

  it('shows exact totals, and no round-off, when the organization has not turned rounding on', async () => {
    const org = await h.makeTenant('POS Exact Org');
    const lines = await stock(org, [99.3]);
    const settings = (await org.client.get('/organization')).data.settings;
    const cart = asCart(lines, [1]);
    const shown = asThePageDoes(settings, cart);
    const saved = await saveSale(org, cart);
    assert.equal(shown.total, 99.3);
    assert.equal(shown.roundOff, 0);
    assert.equal(saved.total, 99.3);
    assert.equal(shown.total, saved.total);
  });

  it('asks the same question on both sides: one rule, two copies, pinned equal', () => {
    for (const settings of [
      undefined,
      {},
      { posRoundOff: false },
      { posRoundOff: true },
      { posRoundOff: true, invoice: { calculation: { roundOffNearest: 1 } } },
      { posRoundOff: true, invoice: { calculation: { roundOffNearest: 0.5 } } },
      { posRoundOff: false, invoice: { calculation: { roundOffNearest: 0.5 } } },
    ]) {
      assert.equal(clientRoundOffFor(settings), serverRoundOffFor(settings), `settings ${JSON.stringify(settings)}`);
    }
    assert.equal(serverRoundOffFor({ posRoundOff: true }), 1, 'on, with nothing chosen: the nearest rupee, as it has always been');
    assert.equal(serverRoundOffFor({ posRoundOff: false, invoice: { calculation: { roundOffNearest: 0.5 } } }), false, 'a chosen step does nothing while rounding is off');
  });
});
