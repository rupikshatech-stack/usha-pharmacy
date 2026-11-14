// Pure unit tests for the timezone helpers (no database).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, isValidTimezone, monthKey, parseLocalDate, startOfDay, startOfMonth, zonedParts, zonedToUtc } from '../utils/tz.js';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const iso = (d) => d.toISOString();

describe('timezone helpers', () => {
  it('Asia/Kolkata is UTC+05:30 with no daylight saving', () => {
    assert.equal(iso(zonedToUtc({ year: 2026, month: 11, day: 6 }, IST)), '2026-11-05T18:30:00.000Z');
    assert.equal(iso(zonedToUtc({ year: 2026, month: 7, day: 1 }, IST)), '2026-06-30T18:30:00.000Z');
  });

  it('reads wall-clock parts of a UTC instant', () => {
    assert.deepEqual(zonedParts(new Date('2026-11-05T18:30:00Z'), IST), { year: 2026, month: 11, day: 6, hour: 0, minute: 0, second: 0 });
    assert.deepEqual(zonedParts(new Date('2026-11-05T18:29:59Z'), IST), { year: 2026, month: 11, day: 5, hour: 23, minute: 59, second: 59 });
  });

  it('startOfDay returns local midnight as a UTC instant, for any time within the day', () => {
    for (const t of ['2026-11-05T18:30:00Z', '2026-11-06T03:00:00Z', '2026-11-06T18:29:59.999Z']) {
      assert.equal(iso(startOfDay(new Date(t), IST)), '2026-11-05T18:30:00.000Z', t);
    }
    assert.equal(iso(startOfDay(new Date('2026-11-06T18:30:00Z'), IST)), '2026-11-06T18:30:00.000Z', 'the next day starts exactly at the boundary');
  });

  it('startOfDay can step by days (calendar arithmetic, month ends included)', () => {
    const now = new Date('2026-11-06T08:00:00Z');
    assert.equal(iso(startOfDay(now, IST, 1)), '2026-11-06T18:30:00.000Z');
    assert.equal(iso(startOfDay(now, IST, -1)), '2026-11-04T18:30:00.000Z');
    assert.equal(dayKey(startOfDay(new Date('2026-03-01T08:00:00Z'), IST, -1), IST), '2026-02-28');
  });

  it('startOfMonth steps across month and year boundaries', () => {
    const now = new Date('2026-01-15T08:00:00Z');
    assert.equal(monthKey(startOfMonth(now, IST, 0), IST), '2026-01');
    assert.equal(monthKey(startOfMonth(now, IST, -1), IST), '2025-12');
    assert.equal(monthKey(startOfMonth(now, IST, -13), IST), '2024-12');
    assert.equal(monthKey(startOfMonth(now, IST, 1), IST), '2026-02');
  });

  it('an instant just before midnight IST belongs to the previous local day/month', () => {
    assert.equal(dayKey(new Date('2026-10-31T18:29:59Z'), IST), '2026-10-31');
    assert.equal(dayKey(new Date('2026-10-31T18:30:00Z'), IST), '2026-11-01');
    assert.equal(monthKey(new Date('2026-10-31T18:29:59Z'), IST), '2026-10');
    assert.equal(monthKey(new Date('2026-10-31T18:30:00Z'), IST), '2026-11');
  });

  it('handles daylight saving (America/New_York): 23-hour and 25-hour days', () => {
    // US DST 2026: starts Sun 8 Mar (day is 23h), ends Sun 1 Nov (day is 25h)
    const spring = startOfDay(new Date('2026-03-08T12:00:00Z'), NY);
    const springNext = startOfDay(new Date('2026-03-08T12:00:00Z'), NY, 1);
    assert.equal((springNext - spring) / 3600000, 23);
    const fall = startOfDay(new Date('2026-11-01T12:00:00Z'), NY);
    const fallNext = startOfDay(new Date('2026-11-01T12:00:00Z'), NY, 1);
    assert.equal((fallNext - fall) / 3600000, 25);
    assert.equal(iso(zonedToUtc({ year: 2026, month: 11, day: 6 }, NY)), '2026-11-06T05:00:00.000Z');
  });

  it('parses calendar dates as LOCAL dates and rejects impossible ones', () => {
    assert.equal(iso(parseLocalDate('2026-04-01', IST)), '2026-03-31T18:30:00.000Z');
    assert.equal(parseLocalDate('2026-02-30', IST), null);
    assert.equal(parseLocalDate('2026-13-01', IST), null);
    assert.equal(parseLocalDate('06/11/2026', IST), null);
    assert.equal(parseLocalDate('', IST), null);
    assert.ok(parseLocalDate('2028-02-29', IST), 'leap day is valid');
    assert.equal(parseLocalDate('2027-02-29', IST), null);
  });

  it('validates IANA timezone names', () => {
    assert.ok(isValidTimezone('Asia/Kolkata'));
    assert.ok(isValidTimezone('UTC'));
    assert.ok(!isValidTimezone('Mars/Olympus'));
    assert.ok(!isValidTimezone(''));
    assert.ok(!isValidTimezone(undefined));
  });
});
