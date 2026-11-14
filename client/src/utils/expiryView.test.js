// How the Expiry Intelligence screen says things. No business figure is worked out here — these check wording,
// colour, and that a filtered view survives a round trip through the address bar.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  DEFAULTS,
  activeFilterCount,
  availableActions,
  bulkActions,
  countdownLabel,
  expiryTone,
  queryFromState,
  searchFromState,
  shelfLifeUsed,
  stateFromSearch,
  units,
} from './expiryView.js';

describe('saying how long is left', () => {
  test('the past tense is spelled out, never shown as a minus sign', () => {
    assert.equal(countdownLabel(0), 'Expires today');
    assert.equal(countdownLabel(-1), 'Expired yesterday');
    assert.equal(countdownLabel(-45), 'Expired 2 months ago');
    assert.equal(countdownLabel(-400), 'Expired over 1 year ago');
    assert.equal(countdownLabel(-800), 'Expired over 2 years ago');
  });

  test('time left reads in the unit a person would use', () => {
    assert.equal(countdownLabel(1), '1 day left');
    assert.equal(countdownLabel(28), '28 days left');
    assert.equal(countdownLabel(120), '4 months left');
    assert.equal(countdownLabel(400), '1.1 years left');
  });

  test('a lot with no expiry recorded says so rather than guessing', () => {
    assert.equal(countdownLabel(null), 'No expiry recorded');
    assert.equal(countdownLabel(undefined), 'No expiry recorded');
  });

  test('the chip colour follows the date, with expired and nearly-expired both urgent', () => {
    assert.equal(expiryTone(-5), 'danger');
    assert.equal(expiryTone(10), 'danger');
    assert.equal(expiryTone(25), 'orange');
    assert.equal(expiryTone(60), 'warning');
    assert.equal(expiryTone(200), 'success');
    assert.equal(expiryTone(null), 'neutral');
  });
});

describe('the shelf-life bar', () => {
  const received = new Date('2026-01-01T00:00:00Z');
  const expiry = new Date('2027-01-01T00:00:00Z');

  test('measures from when the lot arrived to when it expires', () => {
    assert.equal(shelfLifeUsed(received, expiry, new Date('2026-01-01T00:00:00Z')), 0);
    assert.equal(shelfLifeUsed(received, expiry, new Date('2026-07-02T12:00:00Z')), 50);
    assert.equal(shelfLifeUsed(received, expiry, new Date('2026-10-01T00:00:00Z')), 75, 'three quarters of the way through the year');
  });

  test('a lot past its date always reads as full, never past it', () => {
    assert.equal(shelfLifeUsed(received, expiry, new Date('2027-06-01T00:00:00Z')), 100);
  });

  test('copes with a missing received date and a missing expiry', () => {
    assert.ok(shelfLifeUsed(null, expiry, new Date('2026-07-01T00:00:00Z')) > 0, 'falls back to a year of shelf life');
    assert.equal(shelfLifeUsed(received, null), 0, 'with no expiry there is nothing to measure against');
  });
});

describe('counting units', () => {
  test('groups the Indian way and names the unit', () => {
    assert.equal(units(1400, 'tablets'), '1,400 tablets');
    assert.equal(units(250000), '2,50,000 units');
    assert.equal(units(0, 'vials'), '0 vials');
  });
});

describe('the view in the address bar', () => {
  test('a plain visit has a clean URL', () => {
    assert.equal(searchFromState(DEFAULTS), '');
  });

  test('a filtered view survives the round trip', () => {
    const state = { ...DEFAULTS, status: 'under30', riskLevel: 'critical', scheduleCategory: 'H1', search: 'azithro', page: 3, groupBy: 'supplier' };
    const back = stateFromSearch(searchFromState(state));
    assert.deepEqual(back, state, 'what goes into the URL comes back out of it');
  });

  test('only what differs from the default is written', () => {
    const search = searchFromState({ ...DEFAULTS, status: 'expired' });
    assert.equal(search, 'status=expired');
  });

  test('an empty address bar gives the defaults', () => {
    assert.deepEqual(stateFromSearch(''), DEFAULTS);
  });

  test('a nonsense page number falls back rather than breaking the request', () => {
    assert.equal(stateFromSearch('page=0').page, 1);
    assert.equal(stateFromSearch('page=banana').page, 1);
  });

  test('the server is asked only what it can answer', () => {
    const q = queryFromState({ ...DEFAULTS, view: 'calendar', status: 'under15', search: 'dolo' });
    assert.equal(q.view, undefined, 'table or calendar is the browser’s business, not the server’s');
    assert.equal(q.status, 'under15');
    assert.equal(q.search, 'dolo');
    assert.equal(q.manufacturer, undefined, 'an empty filter is not sent at all');
  });

  test('"all stock" is the absence of a status filter, not a status called all', () => {
    assert.equal(queryFromState({ ...DEFAULTS, status: 'all' }).status, undefined);
  });

  test('counts how many filters are narrowing the view', () => {
    assert.equal(activeFilterCount(DEFAULTS), 0);
    assert.equal(activeFilterCount({ ...DEFAULTS, status: 'expired', search: 'x' }), 2);
    assert.equal(activeFilterCount({ ...DEFAULTS, sortBy: 'value', groupBy: 'supplier' }), 0, 'sorting and grouping are not filters');
  });
});

describe('which actions a row offers', () => {
  const row = (over = {}) => ({ status: 'under30', supplierId: 'sup1', clearanceFlagged: false, supplierReturnStatus: null, ...over });

  test('an ordinary lot can be sent back, discounted or written off', () => {
    assert.deepEqual(availableActions(row()), ['returnRequest', 'clearance', 'dispose']);
  });

  test('a lot with no supplier is not offered a supplier return', () => {
    assert.ok(!availableActions(row({ supplierId: null })).includes('returnRequest'), 'there would be nobody to send it to');
  });

  test('a lot already on clearance is offered the way back off it', () => {
    const a = availableActions(row({ clearanceFlagged: true }));
    assert.ok(a.includes('clearanceClear'));
    assert.ok(!a.includes('clearance'));
  });

  test('a quarantined lot must have its return settled before anything else', () => {
    assert.deepEqual(availableActions(row({ supplierReturnStatus: 'requested' })), ['returnSettle']);
  });

  test('a finished lot offers nothing', () => {
    assert.deepEqual(availableActions(row({ status: 'disposed' })), []);
    assert.deepEqual(availableActions(row({ supplierReturnStatus: 'returned' })), []);
    assert.deepEqual(availableActions(null), []);
  });

  test('a bulk action is offered only when it suits every row selected', () => {
    const ordinary = row();
    const noSupplier = row({ supplierId: null });
    assert.ok(bulkActions([ordinary, ordinary]).includes('returnRequest'));
    assert.ok(!bulkActions([ordinary, noSupplier]).includes('returnRequest'), 'one lot without a supplier takes the option away');
    assert.ok(bulkActions([ordinary, noSupplier]).includes('dispose'), 'but both can still be written off');
    assert.deepEqual(bulkActions([]), []);
  });
});
