import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DATE_FORMAT, dateFmt, dateTimeFmt, expiryFmt, formatDateAs, setDisplayDateFormat, setDisplayTimezone } from './format.js';

// The instant is deliberately one where Asia/Kolkata and UTC disagree about the date: 23:30 UTC on 5 Nov is already
// 6 Nov in India. A formatter that ignored the timezone would be a day out.
const instant = '2026-11-05T23:30:00Z';

test('the default format is exactly what every screen has always shown', () => {
  setDisplayTimezone('Asia/Kolkata');
  setDisplayDateFormat(undefined);
  assert.equal(DEFAULT_DATE_FORMAT, 'dd MMM yyyy');
  assert.equal(dateFmt(instant), '06 Nov 2026');
  // And it is the ORIGINAL formatting call, so it matches it character for character rather than approximately.
  assert.equal(dateFmt(instant), new Date(instant).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }));
  assert.equal(
    dateTimeFmt(instant),
    new Date(instant).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
  );
});

test('writes the other three formats', () => {
  setDisplayTimezone('Asia/Kolkata');
  assert.equal(formatDateAs(instant, 'dd/MM/yyyy', 'Asia/Kolkata'), '06/11/2026');
  assert.equal(formatDateAs(instant, 'dd-MM-yyyy', 'Asia/Kolkata'), '06-11-2026');
  assert.equal(formatDateAs(instant, 'yyyy-MM-dd', 'Asia/Kolkata'), '2026-11-06');
});

test('follows the format that was set, for dates, date-times and expiry dates alike', () => {
  setDisplayTimezone('Asia/Kolkata');
  setDisplayDateFormat('yyyy-MM-dd');
  assert.equal(dateFmt(instant), '2026-11-06');
  assert.match(dateTimeFmt(instant), /^2026-11-06, /);
  assert.equal(expiryFmt('2027-03-31T00:00:00Z'), '2027-03-31', 'a date-only expiry is read in UTC so it never slips a day');
  setDisplayDateFormat('dd MMM yyyy');
});

test('changes only the characters, never the instant: a different timezone moves the day, not the data', () => {
  setDisplayDateFormat('dd/MM/yyyy');
  assert.equal(formatDateAs(instant, 'dd/MM/yyyy', 'Asia/Kolkata'), '06/11/2026');
  assert.equal(formatDateAs(instant, 'dd/MM/yyyy', 'America/New_York'), '05/11/2026', 'still 5 Nov in New York — same instant, different wall clock');
  assert.equal(new Date(instant).toISOString(), '2026-11-05T23:30:00.000Z', 'the underlying instant is untouched');
  setDisplayDateFormat('dd MMM yyyy');
});

test('shows a dash for nothing, and falls back to the default for a format it does not know', () => {
  setDisplayDateFormat('dd MMM yyyy');
  assert.equal(dateFmt(null), '—');
  assert.equal(dateFmt(''), '—');
  assert.equal(formatDateAs(instant, 'MM/DD/YY', 'Asia/Kolkata'), '06 Nov 2026');
});
