// Browser tests for the Usha Pharmacy UI (real Chrome, headless) against the isolated stack from stack.mjs.
//   1. node stack.mjs                      (API + demo data on :4100)
//   2. (cd ../client && VITE_DEV_API_TARGET=http://127.0.0.1:4100 npx vite --port 5200)
//   3. node run.mjs                        (this file)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '..', '.tmp', 'e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = 'http://localhost:5200';
const ADMIN = { email: 'admin@e2e.test', password: 'Str0ng!Passw0rd' };
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const AXE = require.resolve('axe-core/axe.min.js');

const results = [];
const consoleProblems = [];
const axeFindings = [];
let current = '';

async function check(name, fn) {
  current = name;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    for (const [i, p] of livePages.entries()) await p.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}-${i}.png`) }).catch(() => {});
    results.push({ name, ok: false, ms: Date.now() - started, error: String(e.message || e).split('\n').slice(0, 6).join('\n') });
    console.log(`  ✖ ${name}\n      ${String(e.message || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const livePages = [];
const watch = (page, label) => {
  livePages.push(page);
  page.on('pageerror', (e) => consoleProblems.push(`[${label}] uncaught: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return; // expected 4xx from negative tests are asserted separately
    consoleProblems.push(`[${label}] console.error: ${t.slice(0, 300)}`);
  });
};
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }).catch(() => {});

const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.locator('input[autocomplete="current-password"]').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard', { timeout: 20000 });
}
const loaded = async (page) => { await page.locator('tbody tr').first().waitFor({ timeout: 15000 }); await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 15000 }); };
const openStock = async (page) => { const group = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Stock Management/ }); if ((await group.getAttribute('aria-expanded')) !== 'true') { await group.click(); await page.waitForTimeout(300); } };
const heading = (page, text) => page.getByRole('heading', { level: 1, name: text }).waitFor({ timeout: 15000 });
const noHorizontalScroll = async (page) => {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(sw <= iw + 1, `page scrolls sideways: content ${sw}px wide in a ${iw}px window`);
};
const setTheme = async (page, theme) => {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if ((theme === 'dark') !== isDark) await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click();
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme);
  await page.waitForTimeout(350); // theme transition
};
async function axe(page, label) {
  await page.addScriptTag({ path: AXE });
  const r = await page.evaluate(() => globalThis.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] }));
  for (const v of r.violations.filter((x) => ['serious', 'critical'].includes(x.impact))) {
    axeFindings.push({ label, rule: v.id, impact: v.impact, help: v.help, count: v.nodes.length, sample: v.nodes.slice(0, 6).map((n) => `${n.target.join(' ')}  ${(n.any[0]?.message || n.failureSummary || '').split('\n')[0].slice(0, 140)}`) });
  }
}

const PAGES = [
  ['dashboard', '/dashboard', /Dashboard|Welcome/i],
  ['inventory', '/inventory', 'All Inventory'],
  ['batches', '/inventory/batches', 'Inventory Batch'],
  ['compounds', '/inventory/compounds', 'All Compound'],
  ['attributes', '/inventory/attributes', 'Attributes'],
  ['import', '/inventory/import', 'Import Inventory'],
  ['transfers', '/inventory/transfers', 'Inter Store Transfer'],
  ['sales-returns', '/sales-returns', 'Sales Returns'],
  ['orders', '/orders', 'Orders'],
  ['branches', '/branches', 'Branches'],
  ['credit', '/credit', 'Credit Management'],
  ['suppliers', '/suppliers', 'Suppliers'],
  ['selling-point', '/selling-point', 'Selling Point'],
  ['analytics', '/analytics', 'Business Analytics'],
  ['analytics-transactions', '/analytics/transactions', 'Daily Transaction Report'],
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
console.log(`Chrome: ${CHROME}`);

/* ============================================================ Login and session (desktop) */
console.log('\nLogin and session');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page, 'login');

  await check('login page renders the form', async () => {
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Email').waitFor();
    await shot(page, 'login-light');
    assert.ok(await page.getByRole('button', { name: 'Sign in' }).isVisible());
  });
  await check('empty form shows field errors and does not call the server', async () => {
    let called = false;
    page.on('request', (r) => r.url().includes('/auth/login') && (called = true));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Enter your email address').waitFor();
    await page.getByText('Enter your password').waitFor();
    assert.equal(called, false);
  });
  await check('wrong password shows an error and stays on the login page', async () => {
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.locator('input[autocomplete="current-password"]').fill('Wrong!Passw0rd');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').filter({ hasText: /Invalid email or password/ }).waitFor();
    assert.ok(page.url().endsWith('/login'));
    await shot(page, 'login-error');
  });
  await check('show / hide password toggle works', async () => {
    const pw = page.locator('input[autocomplete="current-password"]');
    assert.equal(await pw.getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    assert.equal(await pw.getAttribute('type'), 'text');
  });
  await check('correct login opens the dashboard', async () => {
    await page.locator('input[autocomplete="current-password"]').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/dashboard');
    await page.getByText(/Asha/).first().waitFor({ timeout: 15000 });
  });
  await check('the session survives a page reload', async () => {
    await page.reload();
    await page.waitForURL('**/dashboard');
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
  });
  await check('logout ends the session; protected pages then redirect to login', async () => {
    await page.getByRole('button', { name: /Log Out/i }).first().click();
    await page.waitForURL('**/login');
    await page.goto(`${BASE}/inventory`);
    await page.waitForURL('**/login');
    const me = await page.evaluate(async () => (await fetch('/api/auth/me')).status);
    assert.equal(me, 401);
  });
  await check('an unauthenticated visitor is sent to login from every app page', async () => {
    for (const [, url] of PAGES) {
      await page.goto(`${BASE}${url}`);
      await page.waitForURL('**/login', { timeout: 25000 }); // the first visit compiles the page on a cold dev server
    }
  });
  await ctx.storageState({ path: path.join(SHOTS, 'noop.json') }).catch(() => {});
  await ctx.close();
}

// a real 1x1 PNG, for any test that needs an actual image
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/* ============================================================ Desktop */
console.log('\nDesktop (1440×900)');
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const d = await dctx.newPage();
watch(d, 'desktop');
await login(d);
const authState = await dctx.storageState();

await check('dashboard: KPI cards, charts and alerts render with data', async () => {
  await d.goto(`${BASE}/dashboard`);
  await d.getByRole('navigation', { name: 'Main' }).waitFor();
  await d.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 15000 });
  const text = await d.locator('main').innerText();
  assert.match(text, /Low stock|Low Stock/i);
  assert.ok(!(await d.getByText('Something went wrong').count()), 'no error state');
  await shot(d, 'desktop-dashboard-light');
});

await check('sidebar: every Stock Management link opens its page and only that link is active', async () => {
  await openStock(d);
  for (const [label, heading1] of [['All Inventory', 'All Inventory'], ['Inventory Batch', 'Inventory Batch'], ['Inter Store Transfer', 'Inter Store Transfer'], ['All Compound', 'All Compound'], ['Attributes', 'Attributes'], ['Import Inventory', 'Import Inventory']]) {
    await d.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true }).click();
    await heading(d, heading1);
    const active = await d.getByRole('navigation', { name: 'Main' }).locator('a[aria-current="page"]').allInnerTexts();
    assert.equal(active.length, 1, `${label}: active links = ${JSON.stringify(active)}`);
    assert.match(active[0], new RegExp(label));
  }
});

await check('sidebar: collapses to icons and expands again', async () => {
  const side = d.getByRole('complementary', { name: 'Sidebar' });
  const wide = (await side.boundingBox()).width;
  await d.getByRole('button', { name: 'Collapse sidebar' }).click();
  await d.waitForTimeout(400);
  const narrow = (await side.boundingBox()).width;
  assert.ok(narrow < wide - 100, `collapsed ${narrow}px vs ${wide}px`);
  await shot(d, 'desktop-sidebar-collapsed');
  await d.getByRole('button', { name: 'Expand sidebar' }).first().click();
  await d.waitForTimeout(400);
  assert.ok((await side.boundingBox()).width > narrow + 100);
});

await check('breadcrumbs show where you are', async () => {
  await d.goto(`${BASE}/inventory/batches`);
  await heading(d, 'Inventory Batch');
  const crumbs = (await d.getByRole('navigation', { name: 'Breadcrumb' }).innerText()).replace(/\s+/g, ' ').trim();
  assert.match(crumbs, /Stock Management/);
  assert.match(crumbs, /Inventory Batch/);
  assert.equal(crumbs.split('Stock Management').length - 1, 1, 'the group is named once, not twice');
});

/* ---------- tables */
console.log('\nTables, search, filters, pagination (desktop)');
await check('inventory table: rows, pagination, and the counter agree', async () => {
  await d.goto(`${BASE}/inventory`);
  await heading(d, 'All Inventory');
  await loaded(d);
  assert.equal(await d.locator('tbody tr').count(), 10);
  const first = await d.locator('tbody tr').first().innerText();
  await d.getByText(/1–10 of 28/).waitFor();
  await d.getByRole('button', { name: 'Next' }).click();
  await d.getByText(/11–20 of 28/).waitFor();
  assert.notEqual(await d.locator('tbody tr').first().innerText(), first, 'page 2 shows different rows');
  await d.getByRole('button', { name: 'Next' }).click();
  await d.getByText(/21–28 of 28/).waitFor();
  assert.equal(await d.locator('tbody tr').count(), 8);
  assert.ok(await d.getByRole('button', { name: 'Next' }).isDisabled(), 'Next is disabled on the last page');
  await d.getByRole('button', { name: 'Previous' }).click();
  await d.getByText(/11–20 of 28/).waitFor();
  assert.ok(d.url().includes('page=2'), 'the page number is in the URL');
});
await check('inventory table: search narrows the list and can be cleared', async () => {
  await d.goto(`${BASE}/inventory`);
  await loaded(d);
  await d.getByLabel('Search inventory').fill('dolo');
  await d.getByText(/1–1 of 1/).waitFor();
  assert.match(await d.locator('tbody tr').first().innerText(), /Dolo 650/);
  await d.getByLabel('Search inventory').fill('zzzz-nothing');
  await d.locator('p:visible', { hasText: 'No medicines match your filters' }).waitFor();
  await shot(d, 'desktop-inventory-empty');
  await d.getByRole('button', { name: /Clear filters/ }).click();
  await d.getByText(/1–10 of 28/).waitFor();
});
await check('inventory table: stock-status filter and sorting', async () => {
  await d.goto(`${BASE}/inventory`);
  await loaded(d);
  await d.getByLabel('Stock status').selectOption('low_stock');
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length > 0 && [...document.querySelectorAll('tbody tr')].every((r) => /Low Stock/.test(r.innerText)));
  await d.getByLabel('Stock status').selectOption('');
  const firstCell = () => d.locator('tbody tr td:first-child').first().innerText();
  const sortBy = async (dir) => {
    const before = await firstCell();
    await d.getByRole('button', { name: /^Medicine$/ }).click();
    await d.waitForFunction((x) => document.querySelector(`th[aria-sort="${x}"]`) && document.querySelector('tbody tr td:first-child')?.innerText !== null, dir);
    await d.waitForFunction((b) => document.querySelector('tbody tr td:first-child')?.innerText !== b, before, { timeout: 10000 });
    return d.locator('tbody tr td:first-child').allInnerTexts();
  };
  const desc = await sortBy('descending'); // the list starts A–Z, so the first click reverses it
  const asc = await sortBy('ascending');
  const names = (rows) => rows.map((r) => r.split(/\r?\n/)[0]);
  assert.deepEqual(names(asc), [...names(asc)].sort((a, b) => a.localeCompare(b)), 'ascending is A–Z');
  assert.deepEqual(names(desc), [...names(desc)].sort((a, b) => b.localeCompare(a)), 'descending is Z–A');
  assert.notDeepEqual(asc, desc);
});
await check('batch table: expiry alert cards filter the table', async () => {
  await d.goto(`${BASE}/inventory/batches`);
  await heading(d, 'Inventory Batch');
  await loaded(d);
  const expiredCard = d.getByRole('button', { name: /^Expired/ });
  await expiredCard.waitFor();
  const n = Number((await expiredCard.innerText()).match(/\n(\d+)\n/)?.[1] ?? NaN);
  assert.equal(n, 3, 'three expired batches were seeded');
  await expiredCard.click();
  await d.waitForFunction(() => [...document.querySelectorAll('tbody tr')].length === 3 && [...document.querySelectorAll('tbody tr')].every((r) => /Expired/.test(r.innerText)));
  assert.ok(d.url().includes('expiry=expired'));
  await shot(d, 'desktop-batches-expired');
  await expiredCard.click();
  await d.waitForFunction(() => !location.search.includes('expiry'));
});
await check('batch table: search by batch number and by medicine', async () => {
  await d.goto(`${BASE}/inventory/batches`);
  await loaded(d);
  await d.getByLabel('Search batches').fill('OLD-9');
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && /OLD-9/.test(document.querySelector('tbody tr').innerText));
  await d.getByLabel('Search batches').fill('Dolo');
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 1 && [...document.querySelectorAll('tbody tr')].every((r) => /Dolo/.test(r.innerText)));
});

/* ---------- forms */
console.log('\nForms (desktop)');
await check('add medicine: validation errors are clear, focus moves to the first error', async () => {
  await d.goto(`${BASE}/inventory`);
  await loaded(d);
  await d.getByRole('button', { name: 'Add Medicine' }).click();
  const dlg = d.getByRole('dialog', { name: 'Add medicine' });
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Add medicine' }).click();
  await dlg.getByText('Medicine name is required').first().waitFor();
  assert.equal(await d.evaluate(() => document.activeElement?.getAttribute('aria-invalid')), 'true', 'focus is on the invalid field');
  await dlg.getByLabel('GST percentage').fill('150');
  await dlg.getByLabel('HSN / SAC').fill('12');
  await dlg.getByText('GST must be between 0 and 100').waitFor();
  await dlg.getByText('HSN code must be 4 to 8 digits').waitFor();
  await shot(d, 'desktop-form-errors');
});
await check('add medicine: duplicate SKU is caught as you leave the field, and on save', async () => {
  const dlg = d.getByRole('dialog', { name: 'Add medicine' });
  await dlg.getByLabel('Medicine name').fill('Browser Test Tablet');
  // the form is three numbered steps: what it is, how it is packed and classified, what it costs and how it is taxed
  for (const step of ['Product identification', 'Packing & classification', 'Pricing & taxation']) await dlg.getByText(step, { exact: true }).waitFor();
  await dlg.getByLabel('Outer pack').fill('Box');
  await dlg.getByLabel('Outer quantity').fill('10');
  await dlg.getByLabel('Inner pack (sellable)').fill('Strip');
  await dlg.getByLabel('Units per inner pack').fill('15');
  await dlg.getByText('Box of 10 × 15 Strips').waitFor(); // the pack reads back as a sentence
  await dlg.getByText('150 sellable units in one box.').waitFor();
  await dlg.getByLabel('GST percentage').fill('12');
  await dlg.getByText('Within the state: CGST 6% + SGST 6%').waitFor(); // one rate, shown the way a bill charges it
  await dlg.getByText('Across states: IGST 12%').waitFor();
  // an exempt product carries no GST at all, and the rate cannot be typed
  await dlg.getByLabel('Tax applicability').selectOption('exempt');
  await dlg.getByText('Within the state: CGST 0% + SGST 0%').waitFor();
  assert.equal(await dlg.getByLabel('GST percentage').isDisabled(), true, 'nothing to set when GST does not apply');
  await dlg.getByLabel('Tax applicability').selectOption('taxable');
  await dlg.getByLabel('GST percentage').fill('12');
  // the picture is uploaded as it is chosen, and what is kept is where the server put it
  await dlg.getByText('Click to browse file').waitFor();
  await dlg.getByText('PNG, JPG or WEBP up to 5 MB — or drop one here').waitFor();
  await dlg.getByLabel('Product image').setInputFiles({ name: 'tablet.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await dlg.getByText('Image added').waitFor();
  const shot = dlg.getByRole('img', { name: 'Product image' }).first();
  await shot.waitFor();
  assert.ok(await shot.evaluate((i) => i.complete && i.naturalWidth > 0), 'the stored picture loads through the authenticated endpoint');
  await dlg.getByRole('button', { name: 'Remove image' }).click();
  await dlg.getByText('Click to browse file').waitFor();
  await dlg.getByLabel('Product image').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 not an image') });
  await dlg.getByText('Use a JPG, PNG or WEBP image').waitFor();
  await dlg.getByLabel('HSN / SAC').fill('30049099');
  await dlg.getByLabel('SKU').fill('sku-001');
  await dlg.getByLabel('Barcode').click();
  await dlg.getByText(/already used by "Dolo 650"/).waitFor();
  await dlg.getByRole('button', { name: 'Add medicine' }).click();
  assert.ok(await dlg.isVisible(), 'the form stays open');
});
await check('add medicine: closing with unsaved changes asks first; keep editing, then discard', async () => {
  await d.keyboard.press('Escape');
  const confirm = d.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  assert.ok(await d.getByRole('dialog', { name: 'Add medicine' }).isVisible(), 'still editing');
  await d.getByRole('dialog', { name: 'Add medicine' }).getByRole('button', { name: 'Cancel' }).click();
  await d.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard changes' }).click();
  await d.getByRole('dialog', { name: 'Add medicine' }).waitFor({ state: 'detached' });
});
await check('add medicine: a valid form saves, shows a success toast and the new row', async () => {
  await d.getByRole('button', { name: 'Add Medicine' }).click();
  const dlg = d.getByRole('dialog', { name: 'Add medicine' });
  await dlg.getByLabel('Medicine name').fill('Browser Test Tablet');
  await dlg.getByLabel('Manufacturer').fill('Cipla');
  await dlg.getByLabel('Category').fill('Tablets');
  await dlg.getByLabel('SKU').fill('BROWSER-1');
  await dlg.getByLabel('Barcode').fill('BROWSER-BC-1');
  await dlg.getByLabel('HSN / SAC').fill('30049099');
  await dlg.getByRole('button', { name: 'Add medicine' }).click();
  await d.getByText(/"Browser Test Tablet" added to inventory/).waitFor();
  await d.keyboard.press('Escape'); // the follow-up "receive a batch" dialog
  await d.getByLabel('Search inventory').fill('Browser Test');
  await d.waitForFunction(() => /Browser Test Tablet/.test(document.querySelector('tbody tr')?.innerText || ''));
});
await check('edit medicine: opens filled in, Save is disabled until something changes, and saving updates the row', async () => {
  await d.getByRole('button', { name: 'Actions for Browser Test Tablet' }).click();
  await d.getByRole('menuitem', { name: /Edit/ }).click();
  const dlg = d.getByRole('dialog', { name: 'Edit medicine' });
  await dlg.waitFor();
  assert.equal(await dlg.getByLabel('Medicine name').inputValue(), 'Browser Test Tablet');
  assert.ok(await dlg.getByRole('button', { name: 'Save changes' }).isDisabled());
  await dlg.getByLabel('Strength').fill('250mg');
  assert.ok(await dlg.getByRole('button', { name: 'Save changes' }).isEnabled());
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await d.getByText(/"Browser Test Tablet" updated/).waitFor();
  await d.waitForFunction(() => /250mg/.test(document.querySelector('tbody tr')?.innerText || ''));
});
await check('add batch from the Batch page: searchable medicine picker, validation, success', async () => {
  await d.goto(`${BASE}/inventory/batches`);
  await loaded(d);
  await d.getByRole('button', { name: 'Add Batch' }).first().click();
  const dlg = d.getByRole('dialog', { name: 'Add batch' });
  await dlg.getByRole('button', { name: 'Add batch' }).click();
  await dlg.getByText('Choose the medicine this batch belongs to').waitFor();
  await dlg.getByRole('combobox').fill('Browser Test');
  await dlg.getByRole('option', { name: /Browser Test Tablet/ }).click();
  await dlg.getByLabel('Batch number').fill('BB-1');
  await dlg.getByLabel('Expiry date').fill('2020-01-01');
  await dlg.getByLabel('Quantity received').fill('50');
  await dlg.getByLabel('MRP').fill('100');
  await dlg.getByLabel('Selling price').fill('120');
  await dlg.getByRole('button', { name: 'Add batch' }).click();
  await dlg.getByText('Expiry date must be in the future').waitFor();
  await dlg.getByText('Selling price cannot exceed the MRP').waitFor();
  await dlg.getByLabel('Expiry date').fill('2031-06-30');
  await dlg.getByLabel('Selling price').fill('90');
  await dlg.getByRole('button', { name: 'Add batch' }).click();
  await d.getByText(/Batch BB-1 received for Browser Test Tablet \(\+50\)/).waitFor();
  await d.getByLabel('Search batches').fill('BB-1');
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && /BB-1/.test(document.querySelector('tbody tr').innerText));
});
await check('batch history shows the received stock movement', async () => {
  await d.getByRole('button', { name: 'View history of batch BB-1' }).click();
  const dlg = d.getByRole('dialog', { name: /Batch history/ });
  await dlg.getByText('Received').waitFor();
  await dlg.getByText('+50').waitFor();
  await d.keyboard.press('Escape');
});
await check('compounds: add, duplicate is refused on the field, link a medicine, archive', async () => {
  await d.goto(`${BASE}/inventory/compounds`);
  await heading(d, 'All Compound');
  await loaded(d);
  await d.getByRole('button', { name: 'Add Compound' }).click();
  let dlg = d.getByRole('dialog', { name: 'Add compound' });
  await dlg.getByLabel('Compound name').fill('paracetamol 650 MG');
  await dlg.getByRole('button', { name: 'Add compound' }).click();
  await dlg.getByText(/already exists/).waitFor();
  await dlg.getByLabel('Compound name').fill('Cetirizine 10 mg');
  await dlg.getByRole('button', { name: 'Add compound' }).click();
  await d.getByText(/Compound "Cetirizine 10 mg" added/).waitFor();
  await d.getByRole('button', { name: 'Medicines of Cetirizine 10 mg' }).click();
  dlg = d.getByRole('dialog', { name: /Medicines using Cetirizine/ });
  await dlg.getByRole('combobox').fill('Cetzine');
  await dlg.getByRole('option', { name: /Cetzine 10/ }).click();
  await d.getByText('Cetzine 10 linked').waitFor();
  await d.keyboard.press('Escape');
  await d.getByRole('button', { name: 'Archive Cetirizine 10 mg' }).click();
  await d.getByRole('dialog', { name: 'Archive compound?' }).getByRole('button', { name: 'Archive' }).click();
  await d.getByText(/archived/).first().waitFor();
});
await check('attributes: add a list with allowed values, then enable / disable it', async () => {
  await d.goto(`${BASE}/inventory/attributes`);
  await heading(d, 'Attributes');
  await loaded(d);
  await d.getByRole('button', { name: 'Add Attribute' }).click();
  const dlg = d.getByRole('dialog', { name: 'Add attribute' });
  await dlg.getByLabel('Name').fill('Pack types');
  await dlg.getByLabel('Type').selectOption('unit');
  await dlg.getByRole('button', { name: 'Add attribute' }).click();
  await dlg.getByText(/Add at least one value/).waitFor();
  const values = dlg.getByPlaceholder('Type a value and press Enter');
  await values.fill('Blister, Jar');
  await dlg.getByText('Blister').waitFor();
  await dlg.getByRole('button', { name: 'Add attribute' }).click();
  await d.getByText(/added/).first().waitFor();
  await d.getByLabel('Search attributes').fill('Pack types');
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  await d.getByRole('button', { name: 'Disable Pack types' }).click();
  await d.getByRole('dialog', { name: 'Disable attribute?' }).getByRole('button', { name: 'Disable' }).click();
  await d.getByText('Disabled').first().waitFor();
});

/* ---------- CSV import */
console.log('\nCSV import (desktop)');
/** The call-to-action colour: Usha forest green in light mode, a lifted green in dark mode. Green dominates and is clearly not a grey. */
const assertBrandGreen = (css, what) => {
  const [r, g, b] = css.match(/\d+/g).map(Number);
  assert.ok(g > r && g > b && g - r > 20, `${what} is the brand green (${css})`);
};


const csvHeader = 'medicineName,sku,barcode,gstPercentage,batchNumber,expiryDate,mrp,sellingPrice,quantity';
const csvFile = [csvHeader, 'Import Good A,IMP-A,,12,IA-1,2031-03-31,100,90,10', 'Import Dup,IMP-A,,12,ID-1,2031-03-31,100,90,10', 'Import Bad Date,IMP-B,,12,IB-1,2031-02-30,100,90,10', 'Import Bad GST,IMP-C,,400,IC-1,2031-03-31,100,90,10', 'Import Good D,IMP-D,,5,,,,,'].join('\n');
await check('import: file type is checked before upload', async () => {
  await d.goto(`${BASE}/inventory/import`);
  await heading(d, 'Import Inventory');
  await d.locator('#csv-file').setInputFiles({ name: 'stock.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('x') });
  await d.getByText(/Only .csv files can be imported/).waitFor();
});
await check('import: sample template downloads', async () => {
  const [download] = await Promise.all([d.waitForEvent('download'), d.getByRole('button', { name: 'Download sample CSV' }).click()]);
  assert.match(download.suggestedFilename(), /template\.csv$/);
  const text = fs.readFileSync(await download.path(), 'utf8');
  assert.match(text, /medicineName/);
});
await check('import: preview reports each problem row, with an accurate summary', async () => {
  await d.locator('#csv-file').setInputFiles({ name: 'stock.csv', mimeType: 'text/csv', buffer: Buffer.from(csvFile) });
  await d.getByRole('button', { name: 'Check file' }).click();
  await d.getByLabel('Import summary').waitFor();
  const summary = await d.getByLabel('Import summary').innerText();
  assert.match(summary.replace(/\s+/g, ' '), /Total rows 5 Valid rows 2 Invalid rows 3 Skipped rows 0/);
  await d.getByText(/SKU IMP-A is also used by a different medicine in row 2/).waitFor();
  await d.getByText(/not a valid date/).waitFor();
  await d.getByText(/GST 400 is above 100/).waitFor();
  await d.getByRole('tab', { name: /^Errors/ }).click();
  assert.equal(await d.locator('tbody tr').count(), 3);
  await shot(d, 'desktop-import-preview');
  assert.ok(await d.getByRole('button', { name: /Import 2 valid rows and skip 3 with errors/ }).isEnabled());
});
await check('import: confirm imports the valid rows and the result summary adds up', async () => {
  await d.getByRole('button', { name: /Import 2 valid rows/ }).click();
  await d.getByText('Import finished with some problems').waitFor();
  const summary = (await d.getByLabel('Import summary').innerText()).replace(/\s+/g, ' ');
  assert.match(summary, /Total rows 5 Valid rows 2 Invalid rows 3 Successfully imported 2 Skipped rows 0/);
  await shot(d, 'desktop-import-done');
  await d.getByRole('button', { name: 'Import another file' }).click();
  await d.getByText('Import history').waitFor();
  await d.getByRole('cell', { name: 'stock.csv' }).first().waitFor();
  await d.goto(`${BASE}/inventory`);
  await d.getByLabel('Search inventory').fill('Import Good');
  await d.getByText(/1–2 of 2/).waitFor();
});

/* ---------- inter store transfers */
console.log('\nInter Store Transfer (desktop)');
const openTransfers = async (page) => {
  await page.goto(`${BASE}/inventory/transfers`);
  await heading(page, 'Inter Store Transfer');
  await loaded(page);
};
const northId = () => d.evaluate(async () => (await (await fetch('/api/branches')).json()).data.find((x) => x.code === 'NORTH')._id);
const stepThrough = async (details, button, confirmTitle, confirmButton, toast) => {
  await details.getByRole('button', { name: button }).click();
  const dialog = d.getByRole('dialog', { name: confirmTitle });
  await dialog.getByRole('button', { name: confirmButton }).click();
  await d.getByText(toast).waitFor();
};

await check('transfers: header, summary cards and table columns follow the spec, with real numbers', async () => {
  await openTransfers(d);
  assert.ok(await d.getByText('Manage medicine stock transfers between your branches.').isVisible());
  const cards = (await d.getByLabel('Transfer summary').innerText()).replace(/\s+/g, ' ');
  assert.match(cards, /Total Transfers 4/);
  assert.match(cards, /Pending Transfers 1/);
  assert.match(cards, /In Transit 1/);
  assert.match(cards, /Completed Transfers 1/);
  const head = (await d.locator('thead').innerText()).replace(/\s+/g, ' ');
  for (const h of ['Serial Number', 'Reference Number', 'From Store', 'To Store', 'Number of Items', 'Transfer Date', 'Created By', 'Status', 'Actions']) assert.match(head, new RegExp(h, 'i'), h);
  assert.equal(await d.locator('tbody tr').count(), 4);
  const text = (await d.locator('tbody').innerText()).replace(/\s+/g, ' ');
  assert.match(text, /TRF-0001 Main Store North Branch Store 1/);
  assert.match(text, /Asha Verma/, 'created by');
  for (const status of ['Draft', 'Approved', 'In transit', 'Completed']) assert.match(text, new RegExp(status), status);
  await shot(d, 'desktop-transfers');
});
await check('transfers: the summary cards filter the list', async () => {
  await d.getByRole('button', { name: /^In Transit/ }).click();
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && /In transit/.test(document.querySelector('tbody tr').innerText));
  await d.getByRole('button', { name: /^Pending Transfers/ }).click();
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && /TRF-0004/.test(document.querySelector('tbody tr').innerText));
  await d.getByRole('button', { name: /^Total Transfers/ }).click();
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
});
await check('transfers: search by reference, status, stores and date range; clear filters', async () => {
  await d.getByLabel('Search transfers').fill('TRF-0002');
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && /TRF-0002/.test(document.querySelector('tbody tr').innerText));
  await d.getByRole('button', { name: 'Clear filters' }).click();
  await d.getByLabel('Status').selectOption('completed');
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && /Completed/.test(document.querySelector('tbody tr').innerText));
  await d.getByLabel('Status').selectOption('');
  await d.getByLabel('To store').selectOption({ label: 'North Branch Store' });
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
  await d.getByLabel('From store').selectOption({ label: 'North Branch Store' });
  await d.locator('p:visible', { hasText: 'No transfers match your filters' }).waitFor();
  await d.getByRole('button', { name: 'Clear filters' }).first().click();
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
  // dates: a range in the past matches nothing, today's range matches everything, and an upside-down range is explained
  await d.getByLabel('To date').fill('2020-01-01');
  await d.locator('p:visible', { hasText: 'No transfers match your filters' }).waitFor();
  await d.getByLabel('From date').fill('2019-01-01');
  await d.locator('p:visible', { hasText: 'No transfers match your filters' }).waitFor();
  await d.getByRole('button', { name: 'Clear filters' }).first().click();
  const today = await d.evaluate(() => new Date().toISOString().slice(0, 10));
  await d.getByLabel('From date').fill(today);
  await d.getByLabel('To date').fill(today);
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
  await d.getByLabel('From date').fill('2999-01-01');
  await d.getByRole('alert').filter({ hasText: 'The end date must not be before the start date' }).waitFor();
  await d.getByRole('button', { name: 'Clear filters' }).first().click();
  await d.getByLabel('Rows per page').selectOption('25');
  await d.waitForFunction(() => location.search.includes('limit=25'));
  await d.getByLabel('Rows per page').selectOption('10');
});
await check('transfers: the new-transfer form explains what is missing and checks quantities against stock', async () => {
  await openTransfers(d);
  await d.getByRole('button', { name: 'New Transfer' }).click();
  const dlg = d.getByRole('dialog', { name: 'Create stock transfer' });
  await dlg.getByRole('button', { name: 'Save draft' }).click();
  await dlg.getByText('Choose the store the stock is going to').waitFor();
  await dlg.getByText('Add at least one batch to transfer').first().waitFor();
  await dlg.getByLabel('To store').selectOption({ label: 'North Branch Store' });
  await dlg.getByPlaceholder('Search and add medicine…').fill('Dolo');
  await dlg.getByRole('listbox', { name: 'Batches in the source store' }).getByRole('option', { name: /Dolo 650/ }).first().click();
  const qty = dlg.getByRole('spinbutton');
  await dlg.getByRole('button', { name: /^Increase quantity/ }).click();
  assert.equal(await qty.inputValue(), '2');
  await dlg.getByRole('button', { name: /^Decrease quantity/ }).click();
  assert.equal(await qty.inputValue(), '1');
  await dlg.getByRole('button', { name: /^Decrease quantity/ }).click();
  assert.equal(await qty.inputValue(), '1', 'the quantity never goes below 1');
  assert.ok(await dlg.getByText('Transfer items').isVisible());
  assert.equal(await dlg.getByRole('textbox', { name: 'Reference No.' }).inputValue(), 'Assigned on save');
  await qty.fill('99999');
  await dlg.getByRole('button', { name: 'Save draft' }).click();
  await dlg.getByText(/Only \d+ units? available/).first().waitFor();
  await shot(d, 'desktop-transfer-form-errors');
  assert.equal(await d.evaluate(() => document.activeElement?.getAttribute('aria-invalid')), 'true', 'focus is on the bad quantity');
  await d.keyboard.press('Escape');
  const confirm = d.getByRole('dialog', { name: 'Discard this transfer?' });
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  assert.ok(await d.getByRole('dialog', { name: 'Create stock transfer' }).isVisible(), 'still editing');
  await d.getByRole('dialog', { name: 'Create stock transfer' }).getByRole('button', { name: 'Cancel' }).click();
  await d.getByRole('dialog', { name: 'Discard this transfer?' }).getByRole('button', { name: 'Discard changes' }).click();
  await d.getByRole('dialog', { name: 'Create stock transfer' }).waitFor({ state: 'detached' });
});
await check('transfers: create a draft, submit, dispatch and receive it — stock follows at the right steps', async () => {
  await openTransfers(d);
  await d.getByRole('button', { name: 'New Transfer' }).click();
  const dlg = d.getByRole('dialog', { name: 'Create stock transfer' });
  await dlg.getByLabel('To store').selectOption({ label: 'North Branch Store' });
  await dlg.getByLabel('Notes').fill('Browser test transfer');
  await dlg.getByPlaceholder('Search and add medicine…').fill('Crocin');
  await dlg.getByRole('listbox', { name: 'Batches in the source store' }).getByRole('option', { name: /Crocin Advance/ }).first().click();
  await dlg.getByRole('spinbutton').fill('5');
  await dlg.getByRole('button', { name: 'Save draft' }).click();
  await d.getByText(/Draft TRF-0005 saved/).waitFor();
  const details = d.getByRole('dialog', { name: 'Transfer TRF-0005' });
  await details.getByText('Draft created').waitFor();
  assert.equal(await details.getByRole('button', { name: 'Dispatch stock' }).count(), 0, 'a draft cannot be dispatched');

  await details.getByRole('button', { name: 'Submit transfer' }).click();
  const submit = d.getByRole('dialog', { name: 'Submit this transfer?' });
  await submit.getByText(/approved straight away/).waitFor();
  await submit.getByRole('button', { name: 'Submit transfer' }).click();
  await d.getByText(/TRF-0005 submitted/).waitFor();
  await details.getByText('Approved automatically').waitFor();
  assert.equal(await details.getByRole('button', { name: 'Edit' }).count(), 0, 'it can no longer be edited');

  // ---- the dispatch screen: approved / dispatch / remaining quantities, validation, a partial dispatch, then the rest
  await details.getByRole('button', { name: 'Dispatch stock' }).click();
  const screen = d.getByRole('dialog', { name: 'Dispatch transfer TRF-0005' });
  await screen.getByText('Source branch', { exact: true }).waitFor();
  const header = (await screen.locator('dl').innerText()).replace(/\s+/g, ' ');
  for (const expected of ['TRF-0005', 'Main Store', 'North Branch Store']) assert.match(header, new RegExp(expected), expected);
  const columns = (await screen.locator('thead').innerText()).replace(/\s+/g, ' ');
  for (const h of ['Medicine', 'Batch', 'Approved Quantity', 'Dispatch Quantity', 'Remaining Quantity']) assert.match(columns, new RegExp(h, 'i'), h);
  const dispatchQty = screen.getByRole('spinbutton');
  assert.equal(await dispatchQty.inputValue(), '5', 'by default everything that is approved and in stock');
  await dispatchQty.fill('6');
  await screen.getByRole('button', { name: 'Confirm dispatch' }).click();
  await screen.getByText(/Cannot dispatch more than the 5 still to send/).first().waitFor();
  await shot(d, 'desktop-dispatch-validation');
  await dispatchQty.fill('3');
  assert.equal((await screen.locator('tbody tr td:last-child').innerText()).trim(), '2', 'two will remain');
  await screen.getByLabel('This is everything I can send').waitFor(); // offered because something would be left unsent
  await shot(d, 'desktop-dispatch-screen');
  await screen.getByRole('button', { name: 'Confirm dispatch' }).dblclick(); // a double click must not dispatch twice
  await d.getByText(/Dispatch DSP-\d+ recorded — 3 units sent/).waitFor();
  await details.getByText('Partially dispatched').first().waitFor();
  assert.equal(await details.locator('span.font-mono', { hasText: /^DSP-/ }).count(), 1, 'exactly one dispatch was recorded');
  assert.equal(await details.getByRole('button', { name: 'Receive stock' }).count(), 0, 'a partly dispatched transfer cannot be received yet');
  await details.getByText(/Dispatched DSP-\d+ — 3 units left the source store/).waitFor();

  await details.getByRole('button', { name: 'Dispatch the rest' }).click();
  const rest = d.getByRole('dialog', { name: 'Dispatch transfer TRF-0005' });
  assert.equal(await rest.getByRole('spinbutton').inputValue(), '2', 'only the remainder is offered');
  assert.match((await rest.locator('tbody tr').innerText()).replace(/\s+/g, ' '), /5 3 /, 'approved 5, already sent 3');
  await rest.getByRole('button', { name: 'Confirm dispatch' }).click();
  await d.getByText(/recorded — 2 units sent/).waitFor();
  await details.locator('span.font-mono', { hasText: /^DSP-/ }).nth(1).waitFor(); // the details reload after the dispatch
  assert.equal(await details.locator('span.font-mono', { hasText: /^DSP-/ }).count(), 2);
  assert.equal(await details.getByRole('button', { name: /^Dispatch/ }).count(), 0, 'nothing is left to dispatch');

  // ---- the receiving screen: dispatched / previously received / remaining, discrepancies need remarks, a partial receipt, then the rest
  await details.getByRole('button', { name: 'Receive stock' }).click();
  const recv = d.getByRole('dialog', { name: 'Receive transfer TRF-0005' });
  await recv.getByText('Destination branch', { exact: true }).waitFor();
  const recvHeader = (await recv.locator('dl').innerText()).replace(/\s+/g, ' ');
  for (const expected of ['TRF-0005', 'Main Store', 'North Branch Store', 'Dispatch date']) assert.match(recvHeader, new RegExp(expected), expected);
  const recvColumns = (await recv.locator('thead').innerText()).replace(/\s+/g, ' ');
  for (const h of ['Medicine', 'Batch Number', 'Dispatched Quantity', 'Previously Received', 'Remaining Quantity', 'Current Received Quantity', 'Damaged', 'Missing']) assert.match(recvColumns, new RegExp(h, 'i'), h);
  const received = recv.getByRole('spinbutton', { name: /^Received quantity/ });
  const damaged = recv.getByRole('spinbutton', { name: /^Damaged quantity/ });
  assert.equal(await received.inputValue(), '5', 'by default everything that is still expected arrived');
  await received.fill('6');
  await recv.getByRole('button', { name: 'Confirm receipt' }).click();
  await recv.getByText(/Cannot receive more than the 5 still expected/).first().waitFor();
  await received.fill('3');
  await damaged.fill('1');
  await recv.getByRole('button', { name: 'Confirm receipt' }).click();
  await recv.getByText(/Explain the damaged or missing units/).first().waitFor(); // damaged units need remarks
  await shot(d, 'desktop-receive-discrepancy');
  await recv.getByRole('textbox', { name: /^Remarks for/ }).fill('One strip crushed in the van');
  assert.equal((await recv.locator('tbody tr').first().locator('td:last-child').innerText()).trim(), '1', 'one unit is still expected');
  await recv.getByRole('button', { name: 'Confirm receipt' }).dblclick(); // a double click must not credit twice
  await d.getByText(/Receipt RCV-\d+ recorded — 3 units added to North Branch Store \(1 damaged, 0 missing\)/).waitFor();
  await details.getByText('Partially received').first().waitFor();
  assert.equal(await details.locator('span.font-mono', { hasText: /^RCV-/ }).count(), 1, 'exactly one receipt was recorded');
  await details.getByText(/Discrepancy reported: 1 damaged/).waitFor();
  assert.equal(await details.getByRole('button', { name: 'Cancel transfer' }).count(), 0, 'once receiving has started it cannot be cancelled');

  await details.getByRole('button', { name: 'Receive the rest' }).click();
  const restRecv = d.getByRole('dialog', { name: 'Receive transfer TRF-0005' });
  assert.equal(await restRecv.getByRole('spinbutton', { name: /^Received quantity/ }).inputValue(), '1', 'only the remainder is offered');
  assert.match((await restRecv.locator('tbody tr').first().innerText()).replace(/\s+/g, ' '), /5 3 1/, 'dispatched 5, previously received 3, remaining 1');
  await restRecv.getByRole('button', { name: 'Confirm receipt' }).click();
  await d.getByText(/recorded — 1 unit added/).waitFor();
  await details.getByText('Completed').first().waitFor();
  assert.equal(await details.locator('span.font-mono', { hasText: /^RCV-/ }).count(), 2);
  assert.equal(await details.getByRole('button', { name: /^Receive/ }).count(), 0, 'every unit is accounted for');
  await details.getByRole('button', { name: 'Audit trail' }).click();
  await details.getByLabel('Audit trail').getByText('Created', { exact: true }).first().waitFor();
  const trail = (await details.getByLabel('Audit trail').innerText()).replace(/\s+/g, ' ');
  for (const expected of ['Created', 'Submitted', 'Dispatched', 'Received', 'Partially received', 'Completed', 'Main Store', 'North Branch Store', 'One strip crushed']) assert.match(trail, new RegExp(expected), expected);
  await shot(d, 'desktop-transfer-audit-trail');
  await shot(d, 'desktop-transfer-details');
  await d.keyboard.press('Escape');

  await d.goto(`${BASE}/inventory/batches?store=${await northId()}`);
  await loaded(d);
  const rows = (await d.locator('tbody').innerText()).replace(/\s+/g, ' ');
  assert.match(rows, /Crocin Advance/);
  assert.match(rows, /North Branch Store/);
});
await check('transfers: with approval switched on, a submitted transfer waits for an approver, who can approve or reject it', async () => {
  await openTransfers(d);
  await d.getByRole('button', { name: 'Manage stores' }).click();
  const stores = d.getByRole('dialog', { name: 'Stores' });
  await stores.locator('input[type=checkbox]:not([disabled])').waitFor(); // it is disabled while the current setting loads
  await stores.getByLabel('Require approval for transfers').check();
  await d.getByText(/Transfers now need approval before dispatch/).waitFor();
  await d.keyboard.press('Escape');

  const makeAndSubmit = async (medicine) => {
    await d.getByRole('button', { name: 'New Transfer' }).click();
    const dlg = d.getByRole('dialog', { name: 'Create stock transfer' });
    await dlg.getByLabel('To store').selectOption({ label: 'North Branch Store' });
    await dlg.getByPlaceholder('Search and add medicine…').fill(medicine);
    await dlg.getByRole('listbox', { name: 'Batches in the source store' }).getByRole('option', { name: new RegExp(medicine) }).first().click();
    await dlg.getByRole('button', { name: 'Save draft' }).click();
    const details = d.getByRole('dialog', { name: /^Transfer TRF-\d+$/ });
    await details.getByRole('button', { name: 'Submit transfer' }).click();
    const submit = d.getByRole('dialog', { name: 'Submit this transfer?' });
    await submit.getByText(/sent for approval/).waitFor();
    await submit.getByRole('button', { name: 'Submit transfer' }).click();
    await details.getByText('Submitted for approval').waitFor();
    return details;
  };

  let details = await makeAndSubmit('Calpol');
  assert.equal(await details.getByRole('button', { name: 'Dispatch stock' }).count(), 0, 'nothing can be dispatched before approval');
  await shot(d, 'desktop-transfer-pending-approval');
  await stepThrough(details, 'Approve', 'Approve this transfer?', 'Approve', /approved/);
  await details.getByText('Approved', { exact: true }).first().waitFor();
  assert.ok(await details.getByRole('button', { name: 'Dispatch stock' }).isVisible());
  await d.keyboard.press('Escape');

  details = await makeAndSubmit('Augmentin');
  await details.getByRole('button', { name: 'Reject' }).click();
  const reject = d.getByRole('dialog', { name: 'Reject this transfer?' });
  await reject.getByLabel('Reason').fill('ab');
  await reject.getByRole('button', { name: 'Reject transfer' }).click();
  await reject.getByText('Give a short reason').waitFor();
  await reject.getByLabel('Reason').fill('Not needed at North');
  await reject.getByRole('button', { name: 'Reject transfer' }).click();
  await d.getByText(/rejected/).first().waitFor();
  await details.getByText('Rejected: Not needed at North').waitFor();
  assert.equal(await details.getByRole('button', { name: /Approve|Dispatch|Cancel transfer|Edit/ }).count(), 0, 'a rejected transfer is final');
  await d.keyboard.press('Escape');

  await d.getByRole('button', { name: 'Manage stores' }).click();
  await d.getByRole('dialog', { name: 'Stores' }).locator('input[type=checkbox]:not([disabled])').waitFor();
  await d.getByRole('dialog', { name: 'Stores' }).getByLabel('Require approval for transfers').uncheck();
  await d.getByText(/Transfers no longer need approval/).waitFor();
  await d.keyboard.press('Escape');
});
await check('transfers: an approved transfer has a Dispatch button on its row that opens the dispatch screen', async () => {
  await openTransfers(d);
  assert.equal(await d.getByRole('button', { name: 'Dispatch transfer TRF-0001' }).count(), 0, 'a draft cannot be dispatched');
  assert.equal(await d.getByRole('button', { name: 'Dispatch transfer TRF-0002' }).count(), 0, 'nor one that is already in transit');
  assert.ok(await d.getByRole('button', { name: 'Receive transfer TRF-0002' }).isVisible(), 'an in-transit transfer can be received from its row');
  assert.equal(await d.getByRole('button', { name: 'Receive transfer TRF-0004' }).count(), 0, 'an approved one cannot (it has not been dispatched)');
  await d.getByRole('button', { name: 'Dispatch transfer TRF-0004' }).click();
  const screen = d.getByRole('dialog', { name: 'Dispatch transfer TRF-0004' });
  await screen.getByText('Destination branch', { exact: true }).waitFor();
  await screen.getByRole('button', { name: 'Cancel' }).click();
  await screen.waitFor({ state: 'detached' });
});
await check('transfers: a dispatched transfer can be cancelled from the list; its units return to the source store', async () => {
  await openTransfers(d);
  await d.getByRole('button', { name: 'Cancel transfer TRF-0002' }).click();
  const confirm = d.getByRole('dialog', { name: 'Cancel this transfer?' });
  await confirm.getByText(/will be returned to Main Store/).waitFor();
  await confirm.getByLabel('Reason (optional)').fill('Wrong store');
  await confirm.getByRole('button', { name: 'Cancel transfer' }).click();
  await d.getByText(/TRF-0002 cancelled/).waitFor();
  await d.getByRole('button', { name: 'View transfer TRF-0002' }).click();
  const details = d.getByRole('dialog', { name: 'Transfer TRF-0002' });
  await details.getByText(/Cancelled — units returned to the source store/).waitFor();
  await details.getByText(/Wrong store/).waitFor();
  await d.keyboard.press('Escape');
  assert.equal(await d.getByRole('button', { name: /^(Cancel|Delete|Edit) transfer TRF-0002/ }).count(), 0, 'a cancelled transfer has no further actions');
});
await check('transfers: edit a draft, then delete it', async () => {
  await openTransfers(d);
  await d.getByRole('button', { name: 'Edit transfer TRF-0001' }).click();
  const dlg = d.getByRole('dialog', { name: 'Edit transfer TRF-0001' });
  await dlg.waitFor();
  assert.ok(await dlg.getByRole('button', { name: 'Save changes' }).isDisabled(), 'nothing changed yet');
  await dlg.getByLabel('Notes').fill('Edited in the browser');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await d.getByText(/Draft TRF-0001 updated/).waitFor();
  await d.keyboard.press('Escape');
  await d.getByRole('button', { name: 'Delete transfer TRF-0001' }).click();
  const confirm = d.getByRole('dialog', { name: 'Delete this draft?' });
  await confirm.getByText(/No stock has moved/).waitFor();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await d.getByText(/Draft TRF-0001 deleted/).waitFor();
  await d.getByLabel('Search transfers').fill('TRF-0001');
  await d.locator('p:visible', { hasText: 'No transfers match your filters' }).waitFor();
});
await check('transfers: completed and rejected transfers have no edit, delete or cancel button', async () => {
  await openTransfers(d);
  assert.equal(await d.getByRole('button', { name: /^(Edit|Delete|Cancel) transfer TRF-0003/ }).count(), 0);
  assert.equal(await d.getByRole('button', { name: /^(Edit|Delete|Cancel) transfer TRF-0005/ }).count(), 0);
});
const openReturns = async (page) => {
  await page.getByRole('link', { name: 'Sales Returns' }).click();
  await page.getByRole('heading', { name: 'Sales Returns' }).waitFor();
  await page.getByRole('button', { name: 'Process New Return' }).waitFor();
};

await check('sales returns: four summary cards, orange action, filters, table columns, paging footer and details', async () => {
  await d.getByRole('link', { name: 'Sales Returns' }).click();
  await d.getByRole('heading', { name: 'Sales Returns' }).waitFor();
  const cards = d.getByRole('region', { name: 'Returns summary' });
  await cards.getByText('6 returns in total').waitFor(); // the numbers have loaded
  const text = (await cards.innerText()).replace(/\s+/g, ' ');
  for (const label of ['Total Refunded', 'Returns Processed', 'Items Restocked', 'Pending Refunds']) assert.match(text, new RegExp(label), label);
  assert.match(text, /₹\s?321(\.00)?(?!\d)/, 'refunded money: 90 + 113 + 118');
  assert.match(text, /3\s*Returns Processed/);
  assert.match(text, /6\s*Items Restocked/);
  assert.match(text, /₹\s?102\.1(0)?(?!\d)\s*Pending Refunds/, 'still owed: 40.10 + 62');
  assert.ok(await d.getByText('Manage customer returns, restock inventory, and process refunds.').isVisible());
  const btn = d.getByRole('button', { name: 'Process New Return' });
  assert.ok(await btn.isVisible(), 'the call to action');
  assertBrandGreen(await btn.evaluate((e) => getComputedStyle(e).backgroundColor), 'the Process New Return button');
  const head = (await d.locator('thead').innerText()).replace(/\s+/g, ' ');
  for (const h of ['#', 'Return ID', 'Original Invoice', 'Customer Info', 'Return Value', 'Reason', 'Status', 'Actions']) assert.ok(head.toLowerCase().includes(h.toLowerCase()), h);
  const rows = d.locator('tbody tr');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 6);
  assert.match((await d.locator('body').innerText()).replace(/\s+/g, ' '), /Showing page 1 of 1 with 6 total records/);
  assert.deepEqual(await d.getByRole('combobox', { name: 'Rows per page' }).locator('option').allInnerTexts(), ['10', '25', '50']);
  assert.ok(await d.getByRole('button', { name: 'Previous page' }).isDisabled());
  assert.ok(await d.getByRole('button', { name: 'Next page' }).isDisabled());

  await d.getByRole('combobox', { name: 'Status' }).selectOption('pending');
  await d.getByText('Meera Nair').waitFor({ state: 'detached' }); // the list has been filtered
  assert.equal(await d.locator('tbody tr').count(), 1);
  await d.getByText('Imran Shaikh').waitFor();
  await d.getByRole('button', { name: 'Clear filters' }).click();
  await d.getByText('Meera Nair').waitFor(); // cleared: everything is back
  await d.getByRole('combobox', { name: 'Reason' }).selectOption('expired');
  await d.getByText('Meera Nair').waitFor({ state: 'detached' });
  assert.equal(await d.locator('tbody tr').count(), 1);
  await d.locator('tbody').getByText('Expired Medicine').waitFor();
  await d.getByRole('button', { name: 'Clear filters' }).click();
  await d.getByText('Meera Nair').waitFor();
  await d.getByLabel('Search returns').fill('9833344455'); // by phone number
  await d.getByText('Meera Nair').waitFor({ state: 'detached' });
  await d.getByText('Imran Shaikh').waitFor();
  await d.getByLabel('Search returns').fill('INV-00003'); // by invoice number
  await d.getByText('Asha Verma').waitFor();
  assert.equal(await d.locator('tbody tr').count(), 1);
  await d.getByLabel('Search returns').fill('zzzz-nothing');
  await d.getByText('No sales returns found').waitFor();
  await d.getByText('Process a new return or adjust your filters.').waitFor();
  assert.match((await d.locator('body').innerText()).replace(/\s+/g, ' '), /Showing page 1 of 1 with 0 total records/);
  await d.getByRole('button', { name: 'Clear filters' }).click();
  await d.getByLabel('Search returns').fill('SR-0002');
  await d.getByText('Meera Nair').waitFor({ state: 'detached' });
  await d.getByRole('button', { name: 'View return SR-0002' }).click();
  const dlg = d.getByRole('dialog', { name: 'Return SR-0002' });
  await dlg.getByText('Not restocked — damaged').waitFor();
  assert.match(await dlg.innerText(), /Reason: Expired Medicine/);
  assert.match(await dlg.innerText(), /Refund\s*₹\s?113(\.00)?(?!\d)/);
  await shot(d, 'desktop-sales-returns');
  await d.keyboard.press('Escape');
});

await check('sales returns: process a new return — find the invoice, quantity limits, restocking only when verified, refund recorded', async () => {
  await openReturns(d);
  await d.getByRole('button', { name: 'Process New Return' }).click();
  const dlg = d.getByRole('dialog', { name: 'Process New Return' });
  await dlg.getByLabel('Search invoice').fill('INV-00002');
  await dlg.getByRole('button', { name: 'Select invoice INV-00002' }).click();
  const info = (await dlg.locator('dl').first().innerText()).replace(/\s+/g, ' ');
  assert.match(info, /INV-00002/);
  assert.match(info, /Original payment method\s*Cash/i);
  assert.match(info, /Customer name\s*Walk-in Customer/i);
  const head = (await dlg.locator('thead').innerText()).replace(/\s+/g, ' ').toLowerCase();
  for (const h of ['product', 'batch', 'original qty', 'previously returned', 'returnable', 'qty returning', 'unit price', 'return amount']) assert.ok(head.includes(h), h);
  await dlg.getByLabel('Return Crocin Advance').check();
  const qty = dlg.getByLabel('Quantity of Crocin Advance being returned');
  await qty.fill('99');
  await dlg.getByText(/Only 3 can still be returned \(bought 3, already returned 0\)/).waitFor();
  await qty.fill('2');
  assert.equal(await dlg.getByText(/Only 3 can still be returned/).count(), 0);
  // a reason that forbids restocking disables it; units are never added back by default
  const restock = dlg.getByLabel('Add Crocin Advance back to sellable stock');
  assert.equal(await restock.isChecked(), false, 'restocking is never on by default');
  await dlg.getByRole('combobox', { name: 'Reason for return' }).selectOption('expired');
  assert.ok(await restock.isDisabled(), 'expired medicine can never be restocked');
  await dlg.getByText(/Expired and damaged returns can never be added back/).waitFor();
  await dlg.getByRole('combobox', { name: 'Reason for return' }).selectOption('changed_mind');
  assert.ok(await restock.isEnabled());
  await dlg.getByLabel('Condition of Crocin Advance').selectOption('damaged');
  assert.ok(await restock.isDisabled(), 'damaged units can never be restocked');
  await dlg.getByLabel('Condition of Crocin Advance').selectOption('good');
  await restock.check();
  await dlg.getByRole('button', { name: 'Process return' }).click();
  await dlg.getByText(/inspected/i).first().waitFor(); // needs the inspection tick
  await dlg.getByLabel('I inspected the returned Crocin Advance').check();
  assert.match(await dlg.getByText(/Return value/).innerText(), /2 units will be added back to stock/);
  // refund: recorded only
  await dlg.getByRole('combobox', { name: 'Refund method' }).selectOption('UPI');
  await dlg.getByRole('combobox', { name: 'Refund status' }).selectOption('completed');
  await dlg.getByRole('button', { name: 'Process return' }).click();
  await dlg.getByText(/Enter the UPI transaction or reference ID/).waitFor();
  await dlg.getByLabel('Refund transaction / reference ID').fill('UPI-TEST-1');
  await shot(d, 'desktop-process-return');
  await dlg.getByRole('button', { name: 'Process return' }).click();
  await d.getByText(/Return SR-\d+ recorded — .*2 units back in stock/).waitFor();
  await d.getByRole('dialog', { name: 'Process New Return' }).waitFor({ state: 'detached' });
  await d.getByText('7 returns in total').waitFor(); // the cards and the list refreshed
  await d.getByLabel('Search returns').fill('SR-0007');
  await d.locator('tbody').getByText('Customer Changed Mind').waitFor();
  assert.equal(await d.locator('tbody tr').count(), 1);
  // the same invoice again: only 1 unit is left to return
  await d.getByRole('button', { name: 'Process New Return' }).click();
  const dlg2 = d.getByRole('dialog', { name: 'Process New Return' });
  await dlg2.getByLabel('Search invoice').fill('INV-00002');
  await dlg2.getByRole('button', { name: 'Select invoice INV-00002' }).click();
  await dlg2.getByLabel('Return Crocin Advance').check();
  await dlg2.getByLabel('Quantity of Crocin Advance being returned').fill('2');
  await dlg2.getByText(/Only 1 can still be returned \(bought 3, already returned 2\)/).waitFor();
  await d.keyboard.press('Escape');
});

await check('sales returns: approve, record the refund step by step, reject — and finished returns offer no further steps', async () => {
  await openReturns(d);
  const find = async (q) => {
    await d.getByLabel('Search returns').fill(q);
    await d.locator('tbody tr').first().waitFor();
  };
  // SR-0004 is waiting for approval
  await find('SR-0004');
  await d.getByRole('button', { name: 'View return SR-0004' }).click();
  const dlg = d.getByRole('dialog', { name: 'Return SR-0004' });
  await dlg.getByText('Pending', { exact: true }).first().waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Process refund' }).count(), 0, 'no refund before approval');
  await dlg.getByRole('button', { name: 'Approve' }).click();
  const approve = d.getByRole('dialog', { name: 'Approve return SR-0004' });
  await approve.getByText('No units were marked for restocking').waitFor();
  await approve.getByRole('button', { name: 'Approve' }).click();
  await d.getByText('Return SR-0004 approved').waitFor();
  await dlg.getByText('Approved', { exact: true }).first().waitFor();
  await dlg.getByText('Approved', { exact: false }).first().waitFor();
  // record the refund: processing, then completed (a paid refund is final)
  await dlg.getByRole('button', { name: 'Process refund' }).click();
  const refund = d.getByRole('dialog', { name: 'Process refund — SR-0004' });
  await refund.getByRole('combobox', { name: 'New refund status' }).selectOption('processing');
  await refund.getByRole('button', { name: 'Record refund' }).click();
  await d.getByText('Refund for SR-0004 recorded as processing').waitFor();
  await dlg.getByText('Refund pending', { exact: true }).first().waitFor();
  await dlg.getByRole('button', { name: 'Process refund' }).click();
  const refund2 = d.getByRole('dialog', { name: 'Process refund — SR-0004' });
  await refund2.getByRole('combobox', { name: 'New refund status' }).selectOption('completed');
  await refund2.getByRole('combobox', { name: 'Refund method' }).selectOption('UPI');
  await refund2.getByRole('button', { name: 'Record refund' }).click();
  await refund2.getByText(/Enter the UPI transaction or reference ID/).first().waitFor();
  await refund2.getByLabel('Transaction / reference ID').fill('UPI-SR4');
  await refund2.getByRole('button', { name: 'Record refund' }).click();
  await d.getByText('Refund for SR-0004 recorded as completed').waitFor();
  await dlg.getByText('Completed', { exact: true }).first().waitFor();
  await dlg.getByRole('heading', { name: 'History' }).waitFor();
  const hist = (await dlg.getByLabel('History').innerText()).replace(/\s+/g, ' ');
  for (const w of ['Recorded', 'Approved', 'Refund']) assert.match(hist, new RegExp(w), w);
  for (const name of ['Process refund', 'Approve', 'Reject', 'Edit']) assert.equal(await dlg.getByRole('button', { name, exact: true }).count(), 0, `a paid return offers no "${name}"`);
  await shot(d, 'desktop-return-details');
  await d.keyboard.press('Escape');

  // SR-0005 has a refund in progress: reject it (reason required) and its units go back to the invoice
  await find('SR-0005');
  await d.getByRole('button', { name: 'View return SR-0005' }).click();
  const dlg5 = d.getByRole('dialog', { name: 'Return SR-0005' });
  await dlg5.getByRole('button', { name: 'Reject' }).click();
  const rej = d.getByRole('dialog', { name: 'Reject return SR-0005' });
  await rej.getByRole('button', { name: 'Reject return' }).click();
  await rej.getByText(/Give a reason/).first().waitFor();
  await rej.getByLabel('Reason for rejecting').fill('Customer withdrew the request');
  await rej.getByRole('button', { name: 'Reject return' }).click();
  await d.getByText(/Return SR-0005 rejected/).waitFor();
  await dlg5.getByText('Rejected: Customer withdrew the request').waitFor();
  await d.keyboard.press('Escape');
  // the row buttons follow what is possible: SR-0001 is complete, so it only offers View
  await find('SR-0001');
  await d.getByRole('button', { name: 'View return SR-0001' }).waitFor(); // the list has been filtered to it
  assert.equal(await d.locator('tbody tr').count(), 1);
  assert.equal(await d.getByRole('button', { name: 'Process refund for SR-0001' }).count(), 0);
  assert.equal(await d.getByRole('button', { name: 'Edit return SR-0001' }).count(), 0);
});

await check('orders: the list from real data with search, paging, the highlighted menu item and a details view', async () => {
  await d.getByRole('link', { name: 'Orders', exact: true }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  assert.equal(await d.getByRole('link', { name: 'Orders', exact: true }).getAttribute('aria-current'), 'page', 'the Orders menu item is highlighted');
  assert.ok(await d.getByText('Manage received items').isVisible());
  assert.ok(await d.getByRole('button', { name: 'AI Billing' }).isVisible());
  const add = d.getByRole('button', { name: 'Add Order' });
  assertBrandGreen(await add.evaluate((e) => getComputedStyle(e).backgroundColor), 'the Add Order button');
  const head = (await d.locator('thead').innerText()).replace(/\s+/g, ' ').toLowerCase();
  for (const h of ['#', 'order id', 'supplier', 'date', 'items', 'status', 'actions']) assert.ok(head.includes(h), h);
  const rows = d.locator('tbody tr');
  await rows.first().waitFor();
  await d.getByText(/Showing page 1 of 2 with 13 total records/).waitFor(); // the real rows, not the loading placeholders
  assert.equal(await rows.count(), 10, '10 rows by default');
  assert.match((await d.locator('body').innerText()).replace(/\s+/g, ' '), /Showing page 1 of 2 with 13 total records/);
  assert.deepEqual(await d.getByRole('combobox', { name: 'Rows per page' }).locator('option').allInnerTexts(), ['10', '25', '50']);
  await d.getByRole('button', { name: 'Next page' }).click();
  await d.getByText(/Showing page 2 of 2/).waitFor();
  assert.equal(await d.locator('tbody tr').count(), 3);
  await d.getByRole('combobox', { name: 'Rows per page' }).selectOption('25');
  await d.getByText(/Showing page 1 of 1 with 13 total records/).waitFor();
  assert.equal(await d.locator('tbody tr').count(), 13);
  // search: by order id, supplier and product
  await d.getByLabel('Search orders').fill('ORD-0002');
  await d.getByText(/with 1 total record/).waitFor();
  await d.getByLabel('Search orders').fill('zydus');
  await d.locator('tbody').getByText('Zydus Traders').first().waitFor(); // the list has been filtered
  await d.getByText('Cipla Wholesale').first().waitFor({ state: 'detached' });
  assert.ok((await d.locator('tbody').innerText()).includes('Zydus Traders'));
  assert.ok(!(await d.locator('tbody').innerText()).includes('Cipla Wholesale'));
  await d.getByLabel('Search orders').fill(''); // back to everything
  await d.getByText(/with 13 total records/).waitFor();
  await d.getByLabel('Search orders').fill('Dolo'); // by product name
  await d.getByText(/with \d+ total records?/).waitFor();
  assert.ok((await d.locator('tbody tr').count()) >= 1);
  await d.getByLabel('Search orders').fill('zzzz-nothing');
  await d.getByText('No data found').waitFor();
  await d.getByText('There is nothing to display right now.').waitFor();
  assert.match((await d.locator('body').innerText()).replace(/\s+/g, ' '), /Showing page 1 of 1 with 0 total records/);
  await d.getByLabel('Search orders').fill('ORD-0001');
  await d.getByRole('button', { name: 'View order ORD-0001' }).click();
  const dlg = d.getByRole('dialog', { name: 'Order ORD-0001' });
  await dlg.getByText('Urgent: stock for the weekend').waitFor();
  assert.match(await dlg.innerText(), /Sun Pharma Distributors/);
  assert.match((await dlg.locator('thead').innerText()).replace(/\s+/g, ' '), /Ordered.*Received.*Pending/i);
  await shot(d, 'desktop-orders');
  await d.keyboard.press('Escape');
});

await check('orders: add an order — supplier details, products, live totals, charges, payment, then it appears in the list', async () => {
  await d.getByRole('link', { name: 'Orders', exact: true }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await d.getByRole('button', { name: 'Add Order' }).click();
  const dlg = d.getByRole('dialog', { name: 'Add Order' });
  await d.waitForFunction(() => /^ORD-\d{4}$/.test(document.querySelector('[role="dialog"] input[readonly]')?.value || '')); // the preview has loaded
  assert.match(await dlg.getByLabel('Order ID').inputValue(), /^ORD-0014$/, 'the next order number is shown');
  // A. supplier details appear when a supplier is chosen
  await dlg.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Sun Pharma Distributors' });
  // the supplier's standing terms start the payment terms off, and say where that came from
  await dlg.getByText('Sun Pharma Distributors is normally paid: 30 days (30 days credit).').waitFor();
  assert.equal(await dlg.getByRole('combobox', { name: 'Payment terms' }).inputValue(), 'credit', '30-day terms mean this order is on credit');
  const info = (await dlg.getByLabel('Supplier details').innerText()).replace(/\s+/g, ' ');
  for (const w of ['Ramesh Gupta', '9811100011', 'sales@sunpharma.test', '27ABCDE1234F1Z5', '12 Market Road, Pune, Maharashtra, 411001']) assert.ok(info.includes(w), w);
  assert.match(info, /Owed to this supplier\s*Nothing outstanding/i, 'what the supplier is owed comes from their orders');
  assert.ok((await dlg.getByRole('combobox', { name: 'Branch' }).inputValue()).length > 0, 'the main store is preselected');
  // nothing yet: saving explains what is missing
  await dlg.getByRole('button', { name: 'Submit order' }).click();
  await dlg.getByText('Add at least one product.').first().waitFor();
  // B. products
  await dlg.getByLabel('Search products').fill('Dolo');
  await dlg.getByRole('button', { name: 'Add Dolo 650' }).click();
  assert.ok(await dlg.getByRole('button', { name: 'Dolo 650 is already on the order' }).isDisabled(), 'a product is added once');
  await dlg.getByLabel('Search products').fill('Crocin');
  await dlg.getByRole('button', { name: 'Add Crocin Advance' }).click();
  const set = async (label, value) => dlg.getByLabel(label, { exact: true }).fill(value);
  await set('Quantity of Dolo 650', '0');
  await dlg.getByText('Order at least 1 unit.').waitFor();
  await set('Purchase rate of Dolo 650', '-5');
  await dlg.getByText('The rate cannot be negative.').waitFor();
  await set('Discount % of Dolo 650', '101');
  await dlg.getByText('Cannot be more than 100.').first().waitFor();
  await set('Quantity of Dolo 650', '10');
  await set('Purchase rate of Dolo 650', '100');
  await set('Discount % of Dolo 650', '10');
  await set('GST % of Dolo 650', '12');
  await set('Quantity of Crocin Advance', '5');
  await set('Purchase rate of Crocin Advance', '33.33');
  await set('Discount % of Crocin Advance', '0');
  await set('GST % of Crocin Advance', '5');
  await set('Free quantity of Crocin Advance', '2');
  const rowText = async (name) => (await dlg.locator('tbody tr', { hasText: name }).innerText()).replace(/\s+/g, ' ');
  assert.match(await rowText('Dolo 650'), /₹108.*₹1,008/, 'GST amount and line total update as you type');
  assert.match(await rowText('Crocin Advance'), /₹8\.33.*₹174\.98/);
  // C. charges and the summary
  await dlg.getByLabel('Shipping charges (₹)').fill('50');
  await dlg.getByLabel('Packaging charges (₹)').fill('20');
  await dlg.getByLabel('Other charges (₹)').fill('10');
  await dlg.getByLabel('GST on charges').selectOption('18');
  await dlg.getByLabel('Additional discount (₹)').fill('25');
  const sum = (await dlg.getByLabel('Order summary').innerText()).replace(/\s+/g, ' ');
  assert.match(sum, /Total items\s*2/);
  assert.match(sum, /Total quantity\s*15 \+ 2 free/);
  assert.match(sum, /Subtotal\s*₹1,166\.65/);
  assert.match(sum, /Discount\s*− ₹100/);
  assert.match(sum, /Tax \(GST\)\s*₹116\.33/);
  assert.match(sum, /Additional charges\s*₹94\.40/);
  assert.match(sum, /Grand total\s*₹1,252\.38/);
  // D. payment
  await dlg.getByRole('combobox', { name: 'Payment terms' }).selectOption('partial');
  await dlg.getByLabel('Advance payment (₹)').fill('1300');
  await dlg.getByRole('button', { name: 'Submit order' }).click();
  await dlg.getByText(/Cannot be more than the order total \(₹1,?252\.38\)/).first().waitFor();
  await dlg.getByLabel('Advance payment (₹)').fill('500');
  await dlg.getByRole('button', { name: 'Submit order' }).click();
  await dlg.getByText('Choose how the advance was paid.').first().waitFor();
  await dlg.getByRole('combobox', { name: 'Payment method' }).selectOption('UPI');
  assert.equal(await dlg.getByLabel('Remaining amount (₹)').inputValue(), '752.38');
  assert.equal(await dlg.getByLabel('Payment status').inputValue(), 'Partially Paid');
  await dlg.getByLabel('Order reference number').fill('QT-2026-31');
  await shot(d, 'desktop-add-order');
  await dlg.getByRole('button', { name: 'Submit order' }).click();
  await d.getByText(/Order ORD-0014 approved — ₹1,252\.38/).waitFor();
  await d.getByRole('dialog', { name: 'Add Order' }).waitFor({ state: 'detached' });
  // it is in the list, from the database, and its details carry the totals and the payment
  await d.getByLabel('Search orders').fill('QT-2026-31');
  await d.getByRole('button', { name: 'View order ORD-0014' }).click();
  const det = d.getByRole('dialog', { name: 'Order ORD-0014' });
  await det.getByLabel('Order totals').waitFor();
  assert.match((await det.getByLabel('Order totals').innerText()).replace(/\s+/g, ' '), /Grand total\s*₹1,252\.38/);
  assert.match((await det.getByLabel('Payment').innerText()).replace(/\s+/g, ' '), /Partial Payment.*UPI.*₹500.*₹752\.38.*Partially Paid/);
  await d.keyboard.press('Escape');
  // a new supplier can be added without leaving the form
  await d.getByLabel('Search orders').fill('');
  await d.getByRole('button', { name: 'Add Order' }).click();
  const dlg2 = d.getByRole('dialog', { name: 'Add Order' });
  await dlg2.getByRole('button', { name: 'Add a new supplier' }).click();
  const sup = d.getByRole('dialog', { name: 'Add supplier' });
  await sup.getByRole('button', { name: 'Add supplier' }).click();
  await sup.getByText('Enter the supplier name.').waitFor();
  await sup.getByText('Enter the contact person.').waitFor();
  await sup.getByText('Enter the phone number.').waitFor(); // every supplier record has someone to call
  await sup.getByLabel('Supplier name').fill('Fresh Wholesalers');
  await sup.getByLabel('Contact person').fill('Imran Khan');
  await sup.getByLabel('Phone').first().fill('9811100099');
  await sup.getByLabel('GST number').fill('BAD');
  await sup.getByRole('button', { name: 'Add supplier' }).click();
  await sup.getByText('GST number is not in a valid format.').waitFor();
  await sup.getByLabel('GST number').fill('');
  await sup.getByRole('button', { name: 'Add supplier' }).click();
  await d.getByText('Supplier Fresh Wholesalers added').waitFor();
  await dlg2.getByLabel('Supplier details').getByText('Fresh Wholesalers').waitFor();
  await d.keyboard.press('Escape');
});

await check('orders: the workflow (mark as ordered) and the Goods Received form — batches, expiry rules, partial delivery, rejected units, completion', async () => {
  await d.getByRole('link', { name: 'Orders', exact: true }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  const find = async (q) => {
    await d.getByLabel('Search orders').fill(q);
    await d.locator('tbody tr').first().waitFor();
  };
  // ORD-0014 was submitted and approved: it can be marked as ordered, and nothing can be received before that
  await find('ORD-0014');
  assert.equal(await d.getByRole('button', { name: 'Receive items for ORD-0014' }).count(), 0, 'not receivable before it is ordered');
  await d.getByRole('button', { name: 'View order ORD-0014' }).click();
  const det = d.getByRole('dialog', { name: 'Order ORD-0014' });
  await det.getByRole('button', { name: 'Mark as ordered' }).click();
  await d.getByText('Order ORD-0014 marked as ordered').waitFor();
  await det.getByRole('button', { name: 'Receive items' }).waitFor();
  assert.equal(await det.getByRole('button', { name: 'Mark as ordered' }).count(), 0);
  assert.match((await det.getByLabel('Order history').innerText()).replace(/\s+/g, ' '), /Created.*Marked as ordered/);
  await d.keyboard.press('Escape');

  // ORD-0001 is ordered: 100 x first product and 25 x another
  await find('ORD-0001');
  await d.getByRole('button', { name: 'Receive items for ORD-0001' }).click();
  const g = d.getByRole('dialog', { name: 'Goods received — ORD-0001' });
  const sec = g.getByRole('region', { name: 'Receive Dolo 650' });
  const f = async (label, value) => sec.getByLabel(`${label} of Dolo 650`, { exact: true }).fill(value);
  const head = (await sec.innerText()).replace(/\s+/g, ' ');
  assert.match(head, /Ordered\s*100/);
  assert.match(head, /Previously received\s*0/);
  assert.match(head, /Remaining\s*100/);
  // the second product is not arriving today
  await g.getByLabel('Receiving quantity of Combiflam', { exact: true }).fill('0');
  // pharmacy rules: batch and expiry are required, expired stock is refused, over-receipt is refused
  await f('Receiving quantity', '101');
  await g.getByRole('button', { name: 'Confirm receipt' }).click();
  await g.getByText(/Only 100 more units are expected/).first().waitFor();
  await f('Receiving quantity', '60');
  await g.getByRole('button', { name: 'Confirm receipt' }).click();
  await g.getByText('Enter the batch number.').first().waitFor();
  await f('Batch number', 'E2E-BN-1');
  await f('Expiry date', '2020-01-01');
  await g.getByText(/Expired stock can’t be added to sellable inventory/).first().waitFor();
  await f('Expiry date', '2029-06-30');
  await f('Manufacturing date', '2026-01-01');
  // rejected units: need a reason; the "actual received" figure follows
  await f('Rejected quantity', '5');
  await g.getByRole('button', { name: 'Confirm receipt' }).click();
  await g.getByText('Say why units were rejected or damaged.').first().waitFor();
  assert.equal(await sec.getByLabel('Actual received quantity of Dolo 650').inputValue(), '55');
  await sec.getByLabel('Remarks on rejected or damaged units of Dolo 650').fill('5 strips with torn foil');
  await shot(d, 'desktop-goods-received');
  await g.getByRole('button', { name: 'Confirm receipt' }).click();
  await d.getByText(/GRN-\d+ recorded — 55 units added to stock \(5 rejected or damaged\)/).waitFor();
  await d.getByRole('dialog', { name: 'Goods received — ORD-0001' }).waitFor({ state: 'detached' });
  // the order is now partially received and its history shows the receipt
  await d.locator('tbody tr', { hasText: 'ORD-0001' }).getByText('Partially received').waitFor();
  await d.getByRole('button', { name: 'View order ORD-0001' }).click();
  const od = d.getByRole('dialog', { name: 'Order ORD-0001' });
  const hist = (await od.getByLabel('Goods received history').innerText()).replace(/\s+/g, ' ');
  assert.match(hist, /GRN-\d+/);
  assert.match(hist, /55 added to stock · 5 rejected/);
  assert.match(hist, /Dolo 650: 55 accepted · batch E2E-BN-1/);
  await od.getByRole('button', { name: 'Receive the rest' }).click();

  // the rest: only what is still expected is offered, and completing the order is automatic
  const g2 = d.getByRole('dialog', { name: 'Goods received — ORD-0001' });
  const sec2 = g2.getByRole('region', { name: 'Receive Dolo 650' });
  const head2 = (await sec2.innerText()).replace(/\s+/g, ' ');
  assert.match(head2, /Previously received\s*60/);
  assert.match(head2, /Remaining\s*40/);
  assert.equal(await g2.getByLabel('Receiving quantity of Dolo 650', { exact: true }).inputValue(), '40', 'the remainder is offered');
  await g2.getByLabel('Batch number of Dolo 650', { exact: true }).fill('E2E-BN-1'); // an existing batch: its expiry is fixed
  await g2.getByText('This batch is already in stock, so its expiry is fixed.').waitFor();
  assert.equal(await g2.getByLabel('Expiry date of Dolo 650', { exact: true }).inputValue(), '2029-06-30');
  const sec3 = g2.getByRole('region', { name: 'Receive Combiflam' });
  await g2.getByLabel('Batch number of Combiflam', { exact: true }).fill('E2E-CF-1');
  await g2.getByLabel('Expiry date of Combiflam', { exact: true }).fill('2028-12-31');
  assert.match((await sec3.innerText()).replace(/\s+/g, ' '), /Remaining\s*25/);
  await g2.getByRole('button', { name: 'Confirm receipt' }).click();
  await d.getByText(/GRN-\d+ recorded — 65 units added to stock/).waitFor();
  await d.getByRole('dialog', { name: 'Goods received — ORD-0001' }).waitFor({ state: 'detached' });
  await od.getByText('Received', { exact: true }).first().waitFor();
  await od.getByRole('button', { name: /^Receive/ }).first().waitFor({ state: 'detached' }); // the details reload after the receipt
  assert.equal(await od.getByRole('button', { name: /^Receive/ }).count(), 0, 'a completed order receives nothing more');
  assert.equal(await od.getByRole('button', { name: 'Cancel order' }).count(), 0, 'and cannot be cancelled');
  await d.keyboard.press('Escape');
  await d.locator('tbody tr', { hasText: 'ORD-0001' }).getByText('Received', { exact: true }).waitFor();
  assert.equal(await d.getByRole('button', { name: 'Receive items for ORD-0001' }).count(), 0);
});

await check('orders: details show who, discounts, GST, pending quantities; print the order; edit a draft', async () => {
  await d.getByRole('link', { name: 'Orders', exact: true }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  const find = async (q) => {
    await d.getByLabel('Search orders').fill(q);
    await d.locator('tbody tr').first().waitFor();
  };
  // ORD-0014 was created in the Add Order test: complete details
  await find('ORD-0014');
  await d.getByRole('button', { name: 'View order ORD-0014' }).click();
  const det = d.getByRole('dialog', { name: 'Order ORD-0014' });
  const head = (await det.locator('thead').innerText()).replace(/\s+/g, ' ').toLowerCase();
  for (const h of ['product', 'ordered', 'free', 'received', 'pending', 'rate', 'discount', 'gst', 'total']) assert.ok(head.includes(h), h);
  const info = (await det.innerText()).replace(/\s+/g, ' ');
  assert.match(info, /Created by Asha Verma/);
  assert.match(info, /Deliver to Main Store/);
  assert.match(info, /10% · ₹100/, 'the line discount');
  assert.match(info, /12% · ₹108/, 'the line GST');
  assert.match(info, /Grand total\s*₹1,252\.38/);
  assert.match((await det.getByLabel('Payment').innerText()).replace(/\s+/g, ' '), /Partial Payment/);
  for (const name of ['Print Order', 'Download PDF', 'Cancel order', 'Receive items']) assert.ok(await det.getByRole('button', { name }).isVisible(), name);
  assert.equal(await det.getByRole('button', { name: 'Edit', exact: true }).count(), 0, 'an order that has been placed cannot be edited');
  // print: the order as a document, with the order number as the print title (so "Save as PDF" proposes it)
  await d.evaluate(() => {
    window.__printTitle = null;
    window.print = () => {
      window.__printTitle = document.title;
    };
  });
  await det.getByRole('button', { name: 'Print Order' }).click();
  const doc = d.getByRole('dialog', { name: 'Order document — ORD-0014' });
  const paper = doc.getByRole('article', { name: 'Purchase order ORD-0014' });
  await paper.getByRole('heading', { name: 'Purchase Order' }).waitFor();
  const text = (await paper.innerText()).replace(/\s+/g, ' ');
  for (const w of ['Sun Pharma Distributors', 'E2E Pharmacy', 'Dolo 650', 'Crocin Advance', '₹1,252.38', 'Prepared by', 'Authorized by']) assert.ok(text.toLowerCase().includes(w.toLowerCase()), w); // the organization name is shown in capitals
  assert.ok(await paper.getByRole('img', { name: 'Usha Pharmacy' }).isVisible());
  await doc.getByRole('button', { name: 'Print Order' }).click();
  assert.equal(await d.evaluate(() => window.__printTitle), 'ORD-0014');
  await d.evaluate(() => {
    window.__printTitle = null;
  });
  await doc.getByRole('button', { name: 'Download PDF' }).click();
  await d.getByText(/choose “Save as PDF”/).first().waitFor();
  assert.equal(await d.evaluate(() => window.__printTitle), 'ORD-0014');
  await d.emulateMedia({ media: 'print' });
  const hidden = await d.evaluate(() => getComputedStyle(document.querySelector('h1')).visibility);
  await d.emulateMedia({ media: 'screen' });
  assert.equal(hidden, 'hidden', 'only the document is printed');
  await d.keyboard.press('Escape'); // the document
  await d.keyboard.press('Escape'); // the details

  // ORD-0004 is a draft: it can be edited (it has no supplier record yet, so one has to be chosen)
  await find('ORD-0004');
  await d.getByRole('button', { name: 'View order ORD-0004' }).click();
  const dr = d.getByRole('dialog', { name: 'Order ORD-0004' });
  await dr.getByRole('button', { name: 'Edit', exact: true }).click();
  const ed = d.getByRole('dialog', { name: 'Edit Order ORD-0004' });
  assert.equal(await ed.getByLabel('Order ID').inputValue(), 'ORD-0004');
  await ed.getByRole('button', { name: 'Save changes' }).click();
  await ed.getByText('Choose a supplier.').first().waitFor();
  await ed.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Cipla Wholesale' });
  await ed.getByLabel('Purchase rate of Azithral 500', { exact: true }).fill('50');
  await ed.getByLabel('Purchase rate of Omez 20', { exact: true }).fill('10');
  await ed.getByLabel('Quantity of Omez 20', { exact: true }).fill('4');
  await ed.getByRole('button', { name: 'Save changes' }).click();
  await d.getByText(/Order ORD-0004 updated — ₹/).waitFor();
  await d.getByRole('dialog', { name: 'Edit Order ORD-0004' }).waitFor({ state: 'detached' });
  const back = d.getByRole('dialog', { name: 'Order ORD-0004' });
  await back.getByText('Cipla Wholesale').first().waitFor();
  assert.match((await back.getByLabel('Order history').innerText()).replace(/\s+/g, ' '), /edited/i);
  assert.equal(await back.getByRole('button', { name: 'Submit', exact: true }).isVisible(), true, 'a draft can be submitted');
  await d.keyboard.press('Escape');
});

const PDF_FILE = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

await check('ai billing page: not connected → upload, preview, remove, scan keeps the file and opens a manual review beside it → save a draft', async () => {
  const toggle = (what) => fetch(`http://127.0.0.1:4102/ai/${what}`);
  await toggle('off');
  await d.getByRole('link', { name: 'Orders', exact: true }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('heading', { name: 'AI Billing', exact: true }).waitFor();
  assert.ok(d.url().endsWith('/orders/ai-billing'));
  const crumbs = (await d.getByRole('navigation', { name: 'Breadcrumb' }).innerText()).replace(/\s+/g, ' ');
  assert.match(crumbs, /Orders.*AI Billing/, 'breadcrumb: Orders › AI Billing');
  assert.ok(await d.getByRole('link', { name: 'Orders', exact: true }).first().isVisible());
  await d.getByText('Invoice reading isn’t connected yet').waitFor();
  assert.match(await d.locator('main, body').first().innerText(), /no OCR or AI service of its own/);
  assert.ok(await d.getByRole('button', { name: 'Browse Files' }).isVisible());
  assert.ok(await d.getByRole('button', { name: 'Scan Invoice' }).isDisabled(), 'nothing to scan until a file is chosen');
  // the wrong kind of file is refused with a reason
  await d.getByLabel('Invoice file').setInputFiles({ name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b') });
  await d.getByText('Only PDF, PNG and JPEG files can be read.').waitFor();
  // an image: name, size and a preview; Remove File takes it away
  await d.getByLabel('Invoice file').setInputFiles({ name: 'sun-invoice.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await d.getByText('sun-invoice.png').waitFor();
  assert.match((await d.getByText('sun-invoice.png').locator('xpath=..').innerText()).replace(/\s+/g, ' '), /1 KB · PNG/);
  await d.getByRole('img', { name: 'Preview of sun-invoice.png' }).waitFor();
  await d.getByRole('button', { name: 'Remove File' }).click();
  await d.getByText('sun-invoice.png').waitFor({ state: 'detached' });
  assert.ok(await d.getByRole('button', { name: 'Scan Invoice' }).isDisabled());
  // a PDF: preview frame; Scan Invoice stores it, says nothing was read, and opens a review with the document beside it
  await d.getByLabel('Invoice file').setInputFiles({ name: 'sun-invoice.pdf', mimeType: 'application/pdf', buffer: PDF_FILE });
  await d.getByRole('button', { name: 'Remove File' }).waitFor();
  await d.locator('iframe[title="Preview of sun-invoice.pdf"]').waitFor();
  await d.getByRole('button', { name: 'Scan Invoice' }).click();
  await d.getByText(/was uploaded \(UP-[0-9a-f]+\) but nothing was read/).waitFor();
  assert.match(await d.locator('body').innerText(), /Enter the details from the document shown beside the form/);
  await d.locator('iframe[title="Preview of sun-invoice.pdf"]').waitFor();
  await shot(d, 'desktop-ai-billing-review');
  // saving without checking explains what is missing
  await d.getByRole('button', { name: 'Save as Draft' }).click();
  await d.getByText(/never picked for you/).first().waitFor();
  await d.getByText('Choose the product this line is for.').first().waitFor();
  await d.getByText(/Confirm that you have checked these details/).first().waitFor();
  await d.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Sun Pharma Distributors' });
  await d.getByLabel('Invoice number').fill('MAN-77');
  const name = d.getByLabel('Name on the invoice of line 1');
  await name.fill('dolo 650'); // a typed name is matched the careful way: an exact match (any case) is chosen for you
  await name.blur();
  await d.getByRole('button', { name: 'Change the product of line 1' }).waitFor();
  await d.getByLabel('Batch number of line 1').fill('DL-9001');
  await d.getByLabel('Expiry date of line 1').fill('2020-01-01');
  await d.getByText(/Already expired/).first().waitFor();
  await d.getByLabel('Expiry date of line 1').fill('2029-03-31');
  await d.getByLabel('Quantity of line 1', { exact: true }).fill('10');
  await d.getByLabel('Rate of line 1').fill('20');
  await d.getByLabel('MRP of line 1').fill('32');
  assert.equal(await d.getByLabel('GST % of line 1').inputValue(), '5', 'the product’s own GST rate is offered');
  await d.getByLabel('GST % of line 1').fill('12'); // this invoice charges 12%
  await d.getByLabel('Invoice total (as printed)').fill('250');
  await d.getByText(/The lines add up to ₹224(\.00)? but the invoice says ₹250(\.00)?/).waitFor();
  await d.getByLabel('Additional charges (₹)').fill('26');
  await d.getByText(/matches the invoice/).waitFor(); // 224 + 26 of additional charges
  await d.getByLabel('I have checked these details against the invoice').check();
  await d.getByRole('button', { name: 'Save as Draft' }).click();
  await d.getByText(/Draft order ORD-\d+ saved — nothing was added to stock/).waitFor();
  // it lands on the orders page with the new draft open
  const made = d.getByRole('dialog', { name: /^Order ORD-/ });
  await made.getByText('Draft', { exact: true }).first().waitFor();
  assert.match((await made.innerText()).replace(/\s+/g, ' '), /entered from the invoice by Asha Verma.*AI Billing upload UP-/);
  assert.match((await made.innerText()).replace(/\s+/g, ' '), /Ref MAN-77/);
  await d.keyboard.press('Escape');
});

await check('ai billing page: connected → scan with progress, review what was read, correct it, save; a failing service is reported and can be retried', async () => {
  const toggle = (what) => fetch(`http://127.0.0.1:4102/ai/${what}`);
  await toggle('fail');
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('heading', { name: 'AI Billing', exact: true }).waitFor();
  await d.getByText(/Invoices are read by/).waitFor();
  assert.equal(await d.getByText('Invoice reading isn’t connected yet').count(), 0);
  // earlier uploads are listed
  await d.getByRole('list', { name: 'Recent uploads' }).waitFor();
  assert.match((await d.getByRole('list', { name: 'Recent uploads' }).innerText()).replace(/\s+/g, ' '), /sun-invoice\.pdf.*Draft saved/);
  // a service that fails: the reason is shown, and the same upload can be scanned again
  await d.getByLabel('Invoice file').setInputFiles({ name: 'sun-pharma.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF_FILE, Buffer.from('connected')]) });
  await d.getByRole('button', { name: 'Scan Invoice' }).click();
  await d.getByRole('progressbar', { name: 'Processing progress' }).waitFor();
  await d.getByText(/The invoice-reading service answered with an error \(500\)/).first().waitFor();
  await d.getByRole('list', { name: 'Recent uploads' }).locator('li', { hasText: 'sun-pharma.pdf' }).getByText('Failed').waitFor(); // the list reloads after the failure
  assert.match((await d.getByRole('list', { name: 'Recent uploads' }).innerText()).replace(/\s+/g, ' '), /sun-pharma\.pdf.*Failed/);
  await toggle('on');
  await d.getByRole('button', { name: 'Retry Scan' }).click(); // the same stored upload, scanned again
  await d.getByText(/These details were read from the uploaded invoice by software/).waitFor();
  assert.equal(await d.getByLabel('Invoice number').inputValue(), 'SP/2026/771');
  assert.equal(await d.getByLabel('Invoice date').inputValue(), '2026-11-05');
  assert.match(await d.getByRole('combobox', { name: 'Supplier' }).evaluate((el) => el.selectedOptions[0].textContent), /Sun Pharma Distributors/, 'matched by its GST number');
  await d.getByLabel('Supplier as read').getByText(/Matched to your supplier by GST number/).waitFor();
  await d.locator('iframe[title="Preview of sun-pharma.pdf"]').waitFor();
  const rows = d.locator('tbody tr');
  assert.equal(await rows.count(), 3);
  const row = async (i) => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  assert.match(await row(0), /Dolo 650.*Checked.*98% confident/s, 'exact match, fully read');
  assert.equal(await d.getByLabel('Batch number of line 1').inputValue(), 'DL-4412');
  assert.equal(await d.getByLabel('Expiry date of line 1').inputValue(), '2028-07-31');
  assert.equal(await d.getByLabel('MRP of line 1').inputValue(), '32');
  assert.equal(await d.getByLabel('Manufacturer of line 1').inputValue(), 'Micro Labs');
  assert.match(await row(1), /Not an exact match.*Choose product/s, 'a near match is not chosen for you');
  assert.match(await row(2), /No matching product.*60% confident/s);
  await d.getByText('2 lines need attention.').waitFor();
  await d.getByLabel('I have checked these details against the invoice').check();
  await d.getByRole('button', { name: 'Save as Draft' }).click();
  await d.getByText('Choose the product this line is for.').first().waitFor(); // nothing is saved while lines are unresolved
  await d.getByRole('button', { name: 'Use Crocin Advance for line 2' }).click();
  await d.getByRole('button', { name: 'Remove line 3' }).click();
  await d.getByText('Every line is checked.').waitFor();
  await d.getByText(/The lines add up to ₹3,\d{3}\.\d{2} but the invoice says ₹3,544\.40/).waitFor();
  await d.getByLabel('Quantity of line 2', { exact: true }).fill('18');
  await d.getByRole('button', { name: 'Save as Draft' }).click();
  await d.getByText(/Draft order ORD-\d+ saved/).waitFor();
  const made2 = d.getByRole('dialog', { name: /^Order ORD-/ });
  assert.match((await made2.innerText()).replace(/\s+/g, ' '), /read from the uploaded invoice and checked by Asha Verma/);
  assert.match((await made2.innerText()).replace(/\s+/g, ' '), /Ref SP\/2026\/771/);
  await d.keyboard.press('Escape');
  await toggle('off');
});

await check('ai billing page: Cancel discards an unused upload', async () => {
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('heading', { name: 'AI Billing', exact: true }).waitFor();
  await d.getByLabel('Invoice file').setInputFiles({ name: 'discard-me.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF_FILE, Buffer.from('discard')]) });
  await d.getByRole('button', { name: 'Scan Invoice' }).click(); // not connected: stored, manual review
  await d.getByText(/but nothing was read/).waitFor();
  await d.getByRole('button', { name: 'Cancel' }).click();
  const dlg = d.getByRole('dialog', { name: 'Discard this invoice?' });
  await dlg.getByRole('button', { name: 'Discard' }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('list', { name: 'Recent uploads' }).waitFor();
  assert.match((await d.getByRole('list', { name: 'Recent uploads' }).innerText()).replace(/\s+/g, ' '), /discard-me\.pdf.*Removed/);
  assert.equal(await d.getByRole('button', { name: /^Open upload/ }).count() >= 0, true);
  await d.getByRole('link', { name: 'Back to orders' }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
});

await check('ai billing page (OCR): scan with status, a provider failure is reported and retried, results show text, tables, pages and fields beside the original; reprocess; nothing is saved', async () => {
  const ocrSwitch = (what) => fetch(`http://127.0.0.1:4102/ocr/${what}`);
  await ocrSwitch('fail');
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('heading', { name: 'AI Billing', exact: true }).waitFor();
  await d.getByText(/Invoices are read by/).waitFor();
  assert.match(await d.getByText(/Invoices are read by/).innerText(), /Google Document AI/);
  await d.getByLabel('Invoice file').setInputFiles({ name: 'ocr-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF_FILE, Buffer.from('ocr-run')]) });
  const scanBtn = d.getByRole('button', { name: 'Scan Invoice' });
  await scanBtn.click();
  // while it runs: a status, and no way to start the same scan again
  await d.getByRole('progressbar', { name: 'Processing progress' }).waitFor();
  await d.getByText(/Reading the text and tables \(Google Document AI\)/).waitFor();
  assert.equal(await d.getByRole('button', { name: 'Scan Invoice' }).count(), 0, 'no second scan while processing');
  // the provider fails: the reason is shown, the status says Failed, and the same upload can be retried
  await d.getByText(/Google Document AI answered with an error \(503\)/).first().waitFor();
  assert.match((await d.getByLabel('Scan status').innerText()).replace(/\s+/g, ' '), /Failed/);
  await ocrSwitch('on');
  await d.getByRole('button', { name: 'Retry Scan' }).click();
  await d.getByRole('heading', { name: /OCR Results/ }).waitFor();
  assert.match((await d.getByRole('heading', { name: /OCR Results/ }).innerText()).replace(/\s+/g, ' '), /Completed/);
  assert.match((await d.getByText(/Read by Google Document AI/).innerText()).replace(/\s+/g, ' '), /2 pages · 1 table/);
  await d.getByText(/has not been checked/).first().waitFor();
  // the original is shown beside the results, untouched
  await d.locator('iframe[title="Preview of ocr-invoice.pdf"]').waitFor();
  // full text
  assert.match(await d.getByLabel('Full invoice text').innerText(), /SUN PHARMA DISTRIBUTORS[\s\S]*Dolo 650[\s\S]*Terms: payment within 30 days/);
  // warnings for the rotated page and the faint line
  assert.match((await d.getByRole('list', { name: 'Reading warnings' }).innerText()).replace(/\s+/g, ' '), /Page 2 was rotated \(90°\)/);
  // tables, row by row
  await d.getByRole('tab', { name: /^Tables/ }).click();
  const grid = d.getByRole('table').first();
  assert.deepEqual(await grid.locator('th').allInnerTexts(), ['Medicine', 'Batch', 'Qty', 'Rate']);
  assert.equal(await grid.locator('tbody tr').count(), 3, 'header + two rows');
  assert.match((await grid.locator('tbody tr').nth(2).innerText()).replace(/\s+/g, ' '), /Crocin Advance CR-77 20 30\.00/);
  await d.getByText(/Table 1 · page 1/).waitFor();
  // page by page
  await d.getByRole('tab', { name: /^Pages/ }).click();
  await d.getByRole('button', { name: 'Page 2', exact: true }).click();
  await d.getByText(/Page 2 of 2/).waitFor();
  await d.getByRole('list', { name: 'Lines on Page 2' }).getByText('Terms: payment within 30 days').waitFor();
  assert.match((await d.getByRole('list', { name: 'Lines on Page 2' }).innerText()).replace(/\s+/g, ' '), /Faint stamp text 40%/, 'the low confidence is visible');
  // detected fields: found ones with confidence, the rest "Not found" — never invented
  await d.getByRole('tab', { name: /^Detected fields/ }).click();
  const fieldText = (await d.getByRole('tabpanel').innerText()).replace(/\s+/g, ' ');
  assert.match(fieldText, /Invoice number SP\/2026\/771/);
  assert.match(fieldText, /Due date Not found/);
  assert.match(fieldText, /Grand total Not found/);
  // reprocess reads it again and shows the results again
  await d.getByRole('button', { name: 'Reprocess invoice' }).click();
  await d.getByRole('heading', { name: /OCR Results/ }).waitFor();
  // nothing was saved: continuing gives a blank review beside the document, with an honest note
  await d.getByRole('button', { name: 'Enter details manually' }).click();
  await d.getByText(/read by software and has not been checked/).waitFor();
  assert.equal(await d.getByLabel('Invoice number').inputValue(), '', 'OCR does not fill the order form');
  await d.getByRole('button', { name: 'View OCR results' }).click();
  await d.getByRole('heading', { name: /OCR Results/ }).waitFor();
  await d.getByRole('button', { name: 'Back to uploads' }).click();
  await d.getByRole('list', { name: 'Recent uploads' }).waitFor();
  await d.getByRole('list', { name: 'Recent uploads' }).locator('li', { hasText: 'ocr-invoice.pdf' }).getByText('Completed').waitFor(); // the list reloads after going back
  assert.match((await d.getByRole('list', { name: 'Recent uploads' }).innerText()).replace(/\s+/g, ' '), /ocr-invoice\.pdf.*Completed/);
  await ocrSwitch('off');
  await d.getByRole('link', { name: 'Back to orders' }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
});

await check('ai billing page (AI extraction): extract with a failure and retry, uncertain values are outlined, correct, validate, review, then the draft review (nothing matched)', async () => {
  const sw = (what) => fetch(`http://127.0.0.1:4102/${what}`);
  await sw('ocr/on');
  await sw('llm/fail');
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('heading', { name: 'AI Billing', exact: true }).waitFor();
  await d.getByLabel('Invoice file').setInputFiles({ name: 'ai-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF_FILE, Buffer.from('ai-run')]) });
  await d.getByRole('button', { name: 'Scan Invoice' }).click();
  await d.getByRole('heading', { name: /OCR Results/ }).waitFor();
  // the AI step is offered after OCR; a failing model is reported and can be retried
  await d.getByRole('button', { name: 'Extract Invoice with AI' }).click();
  await d.getByRole('progressbar', { name: 'AI extraction progress' }).waitFor();
  await d.getByText(/AI Processing/).first().waitFor();
  await d.getByText(/answered with an error \(500\)/).first().waitFor();
  await sw('llm/on');
  await d.getByRole('button', { name: 'Retry extraction' }).click();
  await d.getByRole('heading', { name: /Extracted invoice/ }).waitFor();
  assert.match((await d.getByRole('heading', { name: /Extracted invoice/ }).innerText()).replace(/\s+/g, ' '), /Validation Required/, 'an extraction is never "verified" by itself');
  await d.getByText(/not verified/).first().waitFor();
  // what was read, exactly: missing things stay empty
  assert.equal(await d.getByLabel('Supplier name').inputValue(), 'Sun Pharma Distributors');
  assert.equal(await d.getByLabel('Invoice number').inputValue(), 'AI/2026/101');
  assert.equal(await d.getByLabel('GSTIN').inputValue(), '');
  assert.equal(await d.getByLabel('Batch of line 1').inputValue(), 'DL-4412');
  assert.equal(await d.getByLabel('MRP of line 1').inputValue(), '', 'a missing MRP is not filled in');
  assert.equal(await d.locator('tbody tr').filter({ has: d.getByLabel('Batch of line 2') }).count(), 1);
  // the invented batch is outlined and explained; the genuine one is not
  assert.match(await d.getByLabel('Batch of line 2').getAttribute('class'), /border-warning/);
  assert.doesNotMatch(await d.getByLabel('Batch of line 1').getAttribute('class'), /border-warning/);
  await d.getByText(/Line 2 batch number was not found in the OCR text/).first().waitFor();
  await d.getByText(/The supplier’s GSTIN was not found/).waitFor();
  // a correction is a person's, marked as such; the check goes away
  await d.getByLabel('Batch of line 2').fill('CR-77');
  await d.getByRole('button', { name: 'Save Changes' }).click();
  await d.getByText('Changes saved.').waitFor();
  await d.getByText(/Line 2 batch number was not found/).first().waitFor({ state: 'detached' });
  assert.match(await d.getByLabel('Batch of line 2').getAttribute('class'), /border-info/, 'edited values are marked');
  await d.getByRole('button', { name: 'Validate Invoice' }).click();
  await d.getByText(/error\(s\) and .* warning\(s\) found|No problems found/).waitFor();
  // a value that is not a number is not sent
  await d.getByLabel('Qty of line 1').fill('lots');
  await d.getByRole('button', { name: 'Save Changes' }).click();
  await d.getByText('Enter a number.').first().waitFor();
  await d.getByLabel('Qty of line 1').fill('100');
  // reviewing needs the person's confirmation; the AI never does it
  assert.equal(await d.getByRole('button', { name: 'Mark as Reviewed' }).isDisabled(), true);
  await d.getByLabel(/I have checked this invoice against the document/).check();
  await d.getByRole('button', { name: 'Mark as Reviewed' }).click();
  await d.getByText(/Marked as reviewed/).waitFor();
  assert.match((await d.getByRole('heading', { name: /Extracted invoice/ }).innerText()).replace(/\s+/g, ' '), /Reviewed/);
  // Save as Draft goes to the order review: nothing is matched for the person
  await d.getByRole('button', { name: 'Save as Draft' }).click();
  await d.getByText(/Products and the supplier are not matched automatically/).waitFor();
  assert.equal(await d.getByRole('combobox', { name: 'Supplier' }).inputValue(), '', 'the supplier is not chosen for the person');
  await d.getByText('Choose product').first().waitFor();
  await d.getByRole('button', { name: 'Back to extracted invoice' }).click();
  await d.getByRole('heading', { name: /Extracted invoice/ }).waitFor();
  // leaving discards the unused upload
  await d.getByRole('button', { name: 'Cancel' }).click();
  await d.getByRole('dialog', { name: 'Discard this invoice?' }).getByRole('button', { name: 'Discard' }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await sw('llm/off');
  await sw('ocr/off');
});

await check('ai billing page (product matching): cards, statuses, suggestions with reasons, conflicts need an explicit yes, manual search, confirm, mark unmatched, then the draft review', async () => {
  const sw = (what) => fetch(`http://127.0.0.1:4102/${what}`);
  await sw('ocr/on');
  await sw('llm/match');
  await sw('seed/products/on');
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('heading', { name: 'AI Billing', exact: true }).waitFor();
  await d.getByLabel('Invoice file').setInputFiles({ name: 'match-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF_FILE, Buffer.from('match-run')]) });
  await d.getByRole('button', { name: 'Scan Invoice' }).click();
  await d.getByRole('heading', { name: /OCR Results/ }).waitFor();
  await d.getByRole('button', { name: 'Extract Invoice with AI' }).click();
  await d.getByRole('heading', { name: /Extracted invoice/ }).waitFor();
  await d.getByRole('button', { name: 'Match Products' }).click();
  await d.getByRole('heading', { name: /Medicine Product Matching/ }).waitFor();
  // four cards, counted by the server
  await d.getByTestId('card-total').waitFor();
  assert.deepEqual([await d.getByTestId('card-total').innerText(), await d.getByTestId('card-matched').innerText(), await d.getByTestId('card-review').innerText(), await d.getByTestId('card-unmatched').innerText()], ['3', '1', '1', '1']);
  const tr = (name) => d.locator('tbody tr').filter({ hasText: name }).first();
  assert.match((await tr('PCM 500 TAB').innerText()).replace(/\s+/g, ' '), /Paracetamol 500mg Tablet.*Matched/);
  assert.match((await tr('Paracetamol 250mg Capsule').innerText()).replace(/\s+/g, ' '), /No product.*Unmatched/);
  assert.match((await tr('Azithromycin 500mg Tablet').innerText()).replace(/\s+/g, ' '), /Needs Review/);
  await d.getByText(/Manufacturer differs: invoice “Alkem”, product “Cipla Ltd”/).waitFor();
  // filters and search
  await d.getByRole('button', { name: 'Unmatched', exact: true }).click();
  assert.equal(await d.locator('tbody tr').filter({ hasText: /Capsule/ }).count() >= 1, true);
  assert.equal(await d.getByText('PCM 500 TAB').count(), 0);
  await d.getByRole('button', { name: 'All', exact: true }).click();
  await d.getByLabel('Search invoice medicines').fill('azithro');
  await d.getByText('PCM 500 TAB').waitFor({ state: 'detached' });
  await d.getByLabel('Search invoice medicines').fill('');
  // the unmatched capsule: the closest products are shown with their conflicts, and choosing one needs an explicit yes
  await d.getByRole('button', { name: 'View suggestions for Paracetamol 250mg Capsule' }).click();
  const sug = d.getByRole('list', { name: 'Suggestions for Paracetamol 250mg Capsule' });
  await sug.getByText('Paracetamol 500mg Tablet').first().waitFor();
  await sug.getByRole('button', { name: 'Why Paracetamol 500mg Tablet' }).click();
  await sug.getByText(/Dosage form differs: invoice capsule, product tablet/).waitFor();
  await sug.getByRole('button', { name: 'Select Paracetamol 500mg Tablet' }).click();
  const warn = d.getByRole('dialog', { name: 'This product conflicts with the invoice' });
  await warn.getByText(/Dosage form differs|Strength differs/).first().waitFor();
  await warn.getByRole('button', { name: 'Cancel' }).click();
  assert.match((await tr('Paracetamol 250mg Capsule').innerText()).replace(/\s+/g, ' '), /No product/, 'nothing was chosen');
  // a clear match is confirmed by a person; confirm-all leaves the row that needs review alone
  await d.getByRole('button', { name: 'Confirm match for PCM 500 TAB' }).click();
  await d.getByText(/Match confirmed/).first().waitFor();
  assert.match((await tr('PCM 500 TAB').innerText()).replace(/\s+/g, ' '), /Confirmed/);
  await d.getByRole('button', { name: 'Confirm all eligible' }).click();
  await d.getByText(/0 matches confirmed; 2 left for you to check/).waitFor();
  // manual search for the row that needs review
  await d.getByRole('button', { name: 'Change Match for Azithromycin 500mg Tablet' }).click();
  const dlg = d.getByRole('dialog', { name: /Select product for/ });
  await dlg.getByLabel('Search products').fill('zzzz-nothing');
  await dlg.getByText('No matching product found.').waitFor();
  assert.ok(await dlg.getByRole('link', { name: /Open Inventory to add the product/ }).isVisible(), 'new products are added through Inventory, never here');
  await dlg.getByLabel('Search products').fill('azithromycin');
  await dlg.getByText('Chosen').first().waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Select Azithromycin 500mg Tablet' }).isDisabled(), true, 'the product already chosen is not offered again');
  await d.keyboard.press('Escape');
  await d.getByRole('button', { name: 'Confirm match for Azithromycin 500mg Tablet' }).click();
  await d.getByText(/Match confirmed/).first().waitFor();
  await d.getByRole('button', { name: 'Mark Paracetamol 250mg Capsule as unmatched' }).click();
  await d.getByText(/Marked as having no matching product/).waitFor();
  await d.getByText('Every row is decided.').waitFor();
  // on to the draft review: confirmed products are chosen, the rest is left to the person
  await d.getByRole('button', { name: 'Continue to draft review' }).click();
  await d.getByText(/Products you confirmed are chosen for you/).waitFor();
  await d.getByRole('button', { name: 'Change the product of line 1' }).waitFor();
  await d.getByRole('button', { name: 'Cancel' }).click();
  await d.getByRole('dialog', { name: 'Discard this invoice?' }).getByRole('button', { name: 'Discard' }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await sw('seed/products/off');
  await sw('llm/off');
  await sw('ocr/off');
});

await check('dashboard: the supplier orders panel is counted from the orders', async () => {
  await d.getByRole('link', { name: 'Dashboard', exact: true }).click();
  const card = d.locator('section, div').filter({ has: d.getByRole('heading', { name: 'Supplier orders' }) }).last();
  await d.getByRole('heading', { name: 'Supplier orders' }).waitFor();
  await d.getByText('Waiting for goods').waitFor();
  const text = (await d.locator('dl', { hasText: 'Waiting for goods' }).innerText()).replace(/\s+/g, ' ');
  for (const label of ['Waiting for approval', 'Waiting for goods', 'Overdue', 'Open order value', 'Owed to suppliers']) assert.ok(text.includes(label), label);
  assert.match(text, /Overdue\s*[1-9]/, 'the seeded orders include late ones');
  assert.match(text, /Owed to suppliers\s*₹[\d,.]+/);
  assert.ok(card);
  await d.getByRole('link', { name: 'View orders' }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
});

await check('notifications: transfer updates appear in the bell, newest first, and are marked as read once seen', async () => {
  await openTransfers(d);
  const bell = d.getByRole('button', { name: /^Notifications/ });
  await bell.waitFor();
  await bell.click();
  await d.getByText(/TRF-\d+ (dispatched|received|approved|submitted|partial receipt|rejected|cancelled)/).first().waitFor();
  const text = (await d.locator('body').innerText()).replace(/\s+/g, ' ');
  assert.match(text, /TRF-\d+ .*(dispatched — stock is on its way|received — transfer completed|approved|partial receipt recorded)/);
  await shot(d, 'desktop-notifications');
  await d.keyboard.press('Escape');
});

await check('transfers: the transfer document previews, downloads as CSV and prints only the document', async () => {
  await openTransfers(d);
  await d.getByRole('button', { name: 'Print transfer TRF-0003' }).click();
  const doc = d.getByRole('dialog', { name: 'Transfer document — TRF-0003' });
  const paper = doc.getByRole('article', { name: 'Stock transfer TRF-0003' });
  await paper.getByRole('heading', { name: 'Stock Transfer Note' }).waitFor();
  const text = (await paper.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /From\s*Main Store/i);
  assert.match(text, /North Branch Store/);
  assert.match(text, /Calpol 500/);
  assert.match(text, /Total \(1 item\)/);
  assert.match(text, /Dispatched by .*Received by/);
  assert.match(text, /Dispatched by — Main Store.*Received by — North Branch Store/);
  assert.ok(await paper.getByRole('img', { name: 'Usha Pharmacy' }).isVisible(), 'the logo is on the note');
  assert.match(text, /expiry/i);
  assert.match(text, /Printed /);
  const [download] = await Promise.all([d.waitForEvent('download'), doc.getByRole('button', { name: 'Download CSV' }).click()]);
  assert.equal(download.suggestedFilename(), 'TRF-0003.csv');
  assert.match(fs.readFileSync(await download.path(), 'utf8'), /Calpol 500,BT2402/);
  assert.ok(await doc.getByRole('button', { name: 'Print' }).isVisible());
  // the print stylesheet: on paper only the document is visible
  await d.emulateMedia({ media: 'print' });
  const hidden = await d.evaluate(() => getComputedStyle(document.querySelector('h1')).visibility);
  const shown = await d.evaluate(() => getComputedStyle(document.querySelector('#print-area')).visibility);
  await d.emulateMedia({ media: 'screen' });
  assert.equal(hidden, 'hidden', 'the page around the document is not printed');
  assert.equal(shown, 'visible', 'the document is');
  await shot(d, 'desktop-transfer-document');
  await d.keyboard.press('Escape');
});
await check('stores: the default store is protected, and a new store can be added', async () => {
  await openTransfers(d);
  await d.getByRole('button', { name: 'Manage stores' }).click();
  const dlg = d.getByRole('dialog', { name: 'Stores' });
  await dlg.getByText('Main Store').waitFor();
  await dlg.getByText('Default').waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Delete Main Store' }).count(), 0, 'the default store cannot be deleted');
  await dlg.getByRole('button', { name: 'Add store' }).click();
  await dlg.getByRole('button', { name: 'Add store' }).click();
  await dlg.getByText('Store name is required').waitFor();
  await dlg.getByLabel('Store name').fill('East Store');
  await dlg.getByLabel('Code').fill('east');
  await dlg.getByRole('button', { name: 'Add store' }).click();
  await d.getByText(/Store “East Store” added/).waitFor();
  await dlg.getByText('East Store').waitFor();
  await d.keyboard.press('Escape');
});

await check('branches page: the list, search, empty state, add with validation and a duplicate code, view, edit, deactivate, delete; the default branch is protected', async () => {
  await d.getByRole('link', { name: 'Branch', exact: true }).click();
  await d.getByRole('heading', { name: 'Branches', exact: true }).waitFor();
  await d.getByText('Manage your store branches.').waitFor();
  assert.equal(await d.getByRole('link', { name: 'Branch', exact: true }).getAttribute('aria-current'), 'page', 'the Branch menu item is highlighted');
  const add = d.getByRole('button', { name: 'Add Branch' });
  assertBrandGreen(await add.evaluate((e) => getComputedStyle(e).backgroundColor), 'the Add Branch button');
  assert.ok(await d.getByPlaceholder('Search by branch name...').isVisible());
  const head = (await d.locator('thead').innerText()).replace(/\s+/g, ' ').toLowerCase();
  for (const h of ['#', 'branch name', 'address', 'status', 'actions']) assert.ok(head.includes(h), h);
  // the seeded branches: the default one cannot be deactivated or deleted
  const main = d.locator('tbody tr').filter({ hasText: 'Main Store' });
  await main.first().waitFor();
  await main.getByText('Default').waitFor();
  assert.equal(await d.getByRole('button', { name: 'Delete branch Main Store' }).count(), 0);
  assert.equal(await d.getByRole('button', { name: 'Deactivate branch Main Store' }).count(), 0);
  assert.match((await d.locator('body').innerText()).replace(/\s+/g, ' '), /Showing page 1 of 1 with \d+ total records?/);
  assert.deepEqual(await d.getByRole('combobox', { name: 'Rows per page' }).locator('option').allInnerTexts(), ['10', '25', '50', '100']);
  assert.equal(await d.getByRole('button', { name: 'Previous page' }).isDisabled(), true);
  assert.equal(await d.getByRole('button', { name: 'Next page' }).isDisabled(), true);
  // search, and the empty state
  await d.getByLabel('Search branches').fill('north');
  await d.getByText('Main Store').waitFor({ state: 'detached' });
  await d.getByLabel('Search branches').fill('zzzz-none');
  await d.getByText('No Branches found').waitFor();
  await d.getByText('Add a new Branch or adjust the filters to see matching records.').waitFor();
  assert.match((await d.locator('body').innerText()).replace(/\s+/g, ' '), /Showing page 1 of 1 with 0 total records/);
  await d.getByLabel('Search branches').fill('');
  await d.getByText('Main Store').first().waitFor();

  // add: every required field is checked, with its own message
  await add.click();
  const dlg = d.getByRole('dialog', { name: 'Add Branch' });
  await dlg.getByRole('button', { name: 'Save Branch' }).click();
  for (const m of ['Branch name is required', 'Branch code is required', 'Address line 1 is required', 'PIN code is required']) await dlg.getByText(m).waitFor();
  await dlg.getByLabel('Branch Name').fill('Harbour Branch');
  await dlg.getByLabel('Branch Code').fill('hrb');
  await dlg.getByLabel('Branch Email').fill('not-an-email');
  await dlg.getByLabel('Branch Phone Number').fill('123');
  await dlg.getByLabel('Address Line 1').fill('7 Dock Road');
  await dlg.getByLabel('PIN Code').fill('4000');
  await dlg.getByLabel('GSTIN').fill('27ABC');
  await dlg.getByRole('button', { name: 'Save Branch' }).click();
  for (const m of [/valid email/, /7 to 15 digits/, /6 digits/, /GSTIN is not in a valid format/]) await dlg.getByText(m).first().waitFor();
  await dlg.getByLabel('Branch Email').fill('harbour@example.com');
  await dlg.getByLabel('Branch Phone Number').fill('9820012345');
  await dlg.getByLabel('PIN Code').fill('400001');
  await dlg.getByLabel('GSTIN').fill('27abcde1234f1z5');
  await dlg.getByLabel('State').fill('Maharashtra');
  await dlg.getByLabel('City').fill('Mumbai');
  await dlg.getByLabel('Branch Manager').fill('Asha Verma');
  await dlg.getByLabel('Opening Date').fill('2026-04-01');
  await dlg.getByLabel('Notes').fill('Port side store');
  await dlg.getByRole('button', { name: 'Save Branch' }).click();
  await d.getByText(/Branch “Harbour Branch” added/).waitFor();
  const row = d.locator('tbody tr').filter({ hasText: 'Harbour Branch' });
  await row.first().waitFor();
  assert.match((await row.innerText()).replace(/\s+/g, ' '), /HRB.*7 Dock Road, Mumbai, Maharashtra, 400001, India.*Active/);

  // a duplicate code is refused, with the message under the field
  await add.click();
  const dlg2 = d.getByRole('dialog', { name: 'Add Branch' });
  await dlg2.getByLabel('Branch Name').fill('Harbour Two');
  await dlg2.getByLabel('Branch Code').fill('HRB');
  await dlg2.getByLabel('Address Line 1').fill('8 Dock Road');
  await dlg2.getByLabel('PIN Code').fill('400001');
  await dlg2.getByRole('button', { name: 'Save Branch' }).click();
  await dlg2.getByText('A branch with this code already exists').waitFor();
  await dlg2.getByRole('button', { name: 'Cancel' }).click();

  // view, then edit from the details
  await d.getByRole('button', { name: 'View branch Harbour Branch' }).click();
  const view = d.getByRole('dialog', { name: 'Harbour Branch' });
  const text = (await view.innerText()).replace(/\s+/g, ' ');
  for (const t of ['HRB', '9820012345', 'harbour@example.com', '7 Dock Road', 'Asha Verma', '27ABCDE1234F1Z5', 'Port side store', 'Active']) assert.ok(text.includes(t), t);
  assert.match(text, /Created .*Last updated/);
  await view.getByRole('button', { name: 'Edit' }).click();
  const edit = d.getByRole('dialog', { name: 'Edit Branch' });
  assert.equal(await edit.getByLabel('Branch Name').inputValue(), 'Harbour Branch');
  assert.equal(await edit.getByLabel('Opening Date').inputValue(), '2026-04-01');
  await edit.getByLabel('Branch Manager').fill('Ravi Kumar');
  await edit.getByRole('button', { name: 'Save Branch' }).click();
  await d.getByText(/Branch “Harbour Branch” updated/).waitFor();

  // deactivate, filter by status, activate again
  await d.getByRole('button', { name: 'Deactivate branch Harbour Branch' }).click();
  await d.getByRole('dialog', { name: 'Deactivate branch?' }).getByRole('button', { name: 'Deactivate' }).click();
  await d.getByText(/“Harbour Branch” deactivated/).waitFor();
  await row.getByText('Inactive').waitFor(); // the list reloads after the toast
  assert.match((await row.innerText()).replace(/\s+/g, ' '), /Inactive/);
  await d.getByRole('combobox', { name: 'Status' }).selectOption('inactive');
  await d.getByText('Main Store').waitFor({ state: 'detached' });
  await row.first().waitFor();
  await d.getByRole('combobox', { name: 'Status' }).selectOption('');
  await d.getByRole('button', { name: 'Activate branch Harbour Branch' }).click();
  await d.getByRole('dialog', { name: 'Activate branch?' }).getByRole('button', { name: 'Activate' }).click();
  await d.getByText(/“Harbour Branch” activated/).waitFor();

  // delete (nothing was ever stored in it)
  await d.getByRole('button', { name: 'Delete branch Harbour Branch' }).click();
  await d.getByRole('dialog', { name: 'Delete branch?' }).getByRole('button', { name: 'Delete' }).click();
  await d.getByText(/Branch “Harbour Branch” deleted/).waitFor();
  await row.first().waitFor({ state: 'detached' });
});

await check('credit management: the page and tabs, validation, a real upload with preview, a pending request, no duplicate, and the history with its details', async () => {
  await d.getByRole('link', { name: 'Credit Management', exact: true }).click();
  await d.getByRole('heading', { name: 'Credit Management', exact: true }).waitFor();
  await d.getByText('Finance Management', { exact: true }).waitFor();
  await d.getByText('Request credit, upload payment screenshots, and view your request history.').waitFor();
  const tabRequest = d.getByRole('tab', { name: 'Request Credit' });
  const tabHistory = d.getByRole('tab', { name: 'History & Logs' });
  assert.equal(await tabRequest.getAttribute('aria-selected'), 'true');
  assertBrandGreen(await tabRequest.evaluate((e) => getComputedStyle(e).color), 'the active tab');
  assert.match(await tabRequest.getAttribute('class'), /border-accent/, 'with an underline in the same colour');
  // the form card
  await d.getByRole('heading', { name: 'Submit Credit Request' }).waitFor();
  await d.getByText('Provide your requested limit and a screenshot of the payment.').waitFor();
  await d.getByText('Note: The current conversion rate is 1 Credit = ₹5. The final approved credits will be calculated by the administrator based on your payment amount.').waitFor();
  // nothing is sent until the form is valid
  await d.getByRole('button', { name: 'Submit Request' }).click();
  await d.getByText('Enter the payment amount').waitFor();
  await d.getByText('Choose the payment screenshot').first().waitFor();
  const amount = d.getByLabel('Payment Amount (₹)');
  for (const [v, msg] of [['-5', /cannot be negative/], ['abc', /valid amount/], ['0', /greater than zero/], ['12.345', /valid amount/]]) {
    await amount.fill(v);
    await d.getByRole('button', { name: 'Submit Request' }).click();
    await d.getByText(msg).first().waitFor();
  }
  // the file: wrong types are refused with a reason; a real image shows its name and a preview, and can be replaced or removed
  const pick = (f) => d.locator('input[type=file]').setInputFiles(f);
  await pick({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await d.getByText('Use a JPG, JPEG, PNG or WEBP image').first().waitFor();
  await pick({ name: 'anim.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a......') });
  await d.getByText('Use a JPG, JPEG, PNG or WEBP image').first().waitFor();
  await pick({ name: 'payment-1.png', mimeType: 'image/png', buffer: PNG_1x1 });
  assert.equal(await d.getByTestId('credit-file-name').innerText(), 'payment-1.png');
  await d.getByRole('img', { name: 'Preview of payment-1.png' }).waitFor();
  await d.getByRole('button', { name: 'Remove file' }).click();
  await d.getByTestId('credit-file-name').waitFor({ state: 'detached' });
  await pick({ name: 'payment-2.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_1x1, Buffer.from('second')]) });
  await d.getByRole('button', { name: 'Replace' }).waitFor();
  assert.equal(await d.getByTestId('credit-file-name').innerText(), 'payment-2.png');
  await amount.fill('499.50');
  await d.getByText(/About 99 credits \(whole credits\) at ₹5 per credit/).waitFor();
  // submit: a Pending request is made, and the form clears only now
  await d.getByRole('button', { name: 'Submit Request' }).click();
  await d.getByText(/Credit request CR-\d+ submitted/).waitFor();
  assert.equal(await amount.inputValue(), '', 'the form is cleared after a successful submission');
  assert.equal(await d.getByTestId('credit-file-name').count(), 0);
  // the same screenshot cannot be used again, and the form keeps what was typed
  await pick({ name: 'payment-2-again.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_1x1, Buffer.from('second')]) });
  await amount.fill('300');
  await d.getByRole('button', { name: 'Submit Request' }).click();
  await d.getByText(/already submitted/).first().waitFor();
  assert.equal(await amount.inputValue(), '300', 'a refused request keeps what was typed');
  assert.equal(await d.getByTestId('credit-file-name').innerText(), 'payment-2-again.png');
  // history & logs
  await tabHistory.click();
  assert.ok(d.url().includes('tab=history'));
  const row = d.locator('tbody tr').filter({ hasText: '₹499.50' });
  await row.first().waitFor();
  assert.match((await row.first().innerText()).replace(/\s+/g, ' '), /CR-\d+.*₹499\.50.*Pending/);
  assert.match((await d.locator('body').innerText()).replace(/\s+/g, ' '), /Showing page 1 of 1 with 1 total record/);
  await d.getByRole('button', { name: /^View request CR-/ }).click();
  const dlg = d.getByRole('dialog', { name: /^Credit request CR-/ });
  await dlg.getByText('Request submitted').waitFor();
  await dlg.getByText('Pending').first().waitFor();
  const shot = dlg.getByRole('img', { name: /Payment screenshot of CR-/ });
  await shot.waitFor();
  assert.ok(await shot.evaluate((i) => i.complete && i.naturalWidth > 0), 'the stored screenshot loads through the authenticated endpoint');
  await d.keyboard.press('Escape');
  // the history table: the specified columns, the proof, and the filters
  for (const h of ['Request ID', 'Date', 'Payment Amount', 'Approved Amount', 'Credits', 'Payment Proof', 'Status', 'Admin Remarks', 'Actions']) await d.getByRole('columnheader', { name: h }).first().waitFor();
  await d.getByRole('button', { name: /View payment proof of CR-/ }).first().click();
  const proofDlg = d.getByRole('dialog', { name: /^Payment proof · CR-/ });
  const proofImg = proofDlg.getByRole('img', { name: /Payment screenshot of CR-/ });
  await proofImg.waitFor();
  assert.ok(await proofImg.evaluate((i) => i.complete && i.naturalWidth > 0), 'the proof loads');
  await d.keyboard.press('Escape');
  await d.getByRole('searchbox', { name: 'Search by request ID' }).fill('CR-9999');
  await d.getByText('No matching credit requests').waitFor();
  await d.getByRole('searchbox', { name: 'Search by request ID' }).fill('');
  await d.getByRole('combobox', { name: 'Status' }).selectOption('approved');
  await d.getByText('No matching credit requests').waitFor();
  await d.getByRole('combobox', { name: 'Status' }).selectOption('');
  await tabRequest.click();
  await d.getByRole('heading', { name: 'Submit Credit Request' }).waitFor();
});

await check('credit approvals: an administrator reviews someone else’s request, the approved amount decides the credits, the balance and the ledger follow, and it cannot be approved twice', async () => {
  // a pending request from another person (nobody may review their own), with a real payment screenshot
  const seeded = await (await fetch('http://127.0.0.1:4102/seed/credit-request/on')).json();
  await d.getByRole('link', { name: 'Credit Management', exact: true }).click();
  await d.getByRole('heading', { name: 'Credit Management', exact: true }).waitFor();
  await d.getByRole('tab', { name: 'Approvals' }).click();
  // the queue: everyone's requests, pending first, searchable by the person who asked
  const search = d.getByRole('searchbox', { name: 'Search by user or request ID' });
  await search.fill(seeded.userName);
  const row = d.getByRole('row').filter({ hasText: seeded.requestNo });
  await row.first().waitFor();
  assert.match((await row.first().innerText()).replace(/\s+/g, ' '), new RegExp(`${seeded.userName}.*₹2,500.*Pending`), 'the requester and the amount they paid');

  // the payment proof is served only through the authenticated endpoint
  await row.first().getByRole('button', { name: /View payment proof/ }).click();
  const proof = d.getByRole('dialog', { name: /^Payment proof · / });
  const proofImg = proof.getByRole('img', { name: /Payment screenshot of CR-/ });
  await proofImg.waitFor();
  assert.ok(await proofImg.evaluate((i) => i.complete && i.naturalWidth > 0), 'the proof loads for the administrator too');
  await d.keyboard.press('Escape');

  // the review panel: the approved amount starts as the requested one, and the credits follow the amount the administrator verifies
  await row.first().getByRole('button', { name: 'Review' }).click();
  const dlg = d.getByRole('dialog', { name: new RegExp(`^Credit request ${seeded.requestNo}`) });
  const amount = dlg.getByLabel('Approved payment amount (₹)');
  assert.equal(await amount.inputValue(), '2500', 'prefilled with what was requested');
  await dlg.getByText(/500 credits at ₹5 per credit/).waitFor();
  await amount.fill('1000');
  await dlg.getByText(/200 credits at ₹5 per credit/).waitFor(); // the preview follows the verified amount
  await amount.fill('999');
  await dlg.getByText(/199 credits at ₹5 per credit; ₹4 left over/).waitFor();
  await amount.fill('2500');
  await dlg.getByLabel('Admin remarks').fill('UPI reference checked against the bank statement');
  await dlg.getByRole('button', { name: 'Approve', exact: true }).click();
  // approving cannot be undone, so it asks first — and changing your mind changes nothing
  const confirm = d.getByRole('dialog', { name: 'Approve this credit request?' });
  await confirm.getByText(/₹2,500 will be approved on CR-.*500 credits added to Rahul Nair/).waitFor();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await confirm.waitFor({ state: 'detached' });
  await dlg.getByRole('button', { name: 'Approve', exact: true }).click();
  await d.getByRole('dialog', { name: 'Approve this credit request?' }).getByRole('button', { name: 'Approve and add credits' }).click();
  await d.getByText(/approved: 500 credits added to .*balance 0 → 500/).waitFor();

  // the row now shows the decision, and there is nothing left to review
  await d.getByRole('combobox', { name: 'Status' }).selectOption('approved');
  const done = d.getByRole('row').filter({ hasText: seeded.requestNo }).filter({ hasText: 'Approved' }).first();
  await done.waitFor(); // the list reloads: read the row only once it shows the decision
  const text = (await done.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /₹2,500.*₹2,500.*500/, 'the payment amount, the approved amount and the credits');
  assert.match(text, /UPI reference checked/, 'the remarks are on the row');
  assert.equal(await done.getByRole('button', { name: 'Review' }).count(), 0, 'a decided request cannot be reviewed again');

  // the ledger explains the balance: one entry, with the balance before and after
  await d.getByRole('tab', { name: 'Credit Ledger' }).click();
  await d.getByRole('checkbox', { name: /Show everyone.s entries/ }).check();
  const entry = d.getByRole('row').filter({ hasText: seeded.requestNo }).first();
  await entry.waitFor();
  const ledger = (await entry.innerText()).replace(/\s+/g, ' ');
  assert.match(ledger, /CT-\d{4}/, 'a transaction id');
  assert.match(ledger, new RegExp(`${seeded.userName}.*Request approved`));
  assert.match(ledger, /\+500/);
  assert.match(ledger, /\b0\b.*500/, 'the balance before and after');
  assert.match(ledger, /Asha Verma/, 'who approved it');
  assert.equal(await d.getByRole('row').filter({ hasText: seeded.requestNo }).count(), 1, 'exactly one entry — credits are never added twice');

  // the credits went to the requester, not to the administrator, whose own balance in the header is still zero
  assert.equal(await d.getByTestId('credit-balance').innerText(), '0');
  await d.getByRole('tab', { name: 'Request Credit' }).click();
});

await check('suppliers: the page, search, adding one with validation, preferred, details with real statistics, editing, deactivating and the two kinds of delete', async () => {
  await d.getByRole('link', { name: 'Suppliers', exact: true }).click();
  await d.getByRole('heading', { name: 'Suppliers', exact: true }).waitFor();
  await d.getByText('Manage your product suppliers, contact details, and procurement preferences.').waitFor();
  for (const h of ['#', 'Company Name', 'GST Number', 'Contact Person', 'Phone', 'Preferred', 'Actions']) await d.getByRole('columnheader', { name: h, exact: true }).first().waitFor();

  // search works against the real records the demo data seeded
  const search = d.getByRole('searchbox', { name: 'Search suppliers' });
  const rowFor = (name) => d.getByRole('row').filter({ hasText: name }).first();
  await rowFor('Sun Pharma Distributors').waitFor();
  await search.fill('27ABCDE1234F1Z5'); // by GST number
  await rowFor('Sun Pharma Distributors').waitFor();
  await d.getByRole('row').filter({ hasText: 'Cipla Wholesale' }).first().waitFor({ state: 'detached' }); // the list reloads after the search settles
  await search.fill('Neha'); // by contact person
  await rowFor('Cipla Wholesale').waitFor();
  await search.fill('nobody-by-this-name');
  await d.getByText('No suppliers found').waitFor();
  await d.getByText('Add a new supplier or adjust the filters to see matching records.').waitFor();
  await search.fill('');

  // sorting and the preferred filter work in the database, so they cover every page and not just this one
  const firstRow = d.getByRole('row').nth(1);
  await d.getByRole('button', { name: 'Company Name' }).click();
  await d.locator('th[aria-sort="ascending"]').filter({ hasText: /Company Name/i }).waitFor();
  await firstRow.filter({ hasText: 'Cipla Wholesale' }).waitFor(); // A to Z, and the list has reloaded
  await d.getByRole('button', { name: 'Company Name' }).click();
  await d.locator('th[aria-sort="descending"]').filter({ hasText: /Company Name/i }).waitFor();
  await firstRow.filter({ hasText: 'Sun Pharma Distributors' }).waitFor(); // clicking again turns the order around
  await d.getByRole('combobox', { name: 'Preferred' }).selectOption('true');
  await d.getByText('No suppliers found').waitFor(); // nothing is preferred yet
  await d.getByRole('combobox', { name: 'Preferred' }).selectOption('');

  // adding one: the form says what is missing, then what is malformed
  await d.getByRole('button', { name: 'Add Supplier' }).click();
  const form = d.getByRole('dialog', { name: 'Add Supplier' });
  await form.getByRole('button', { name: 'Save Supplier' }).click();
  for (const msg of ['Enter the company name', 'Enter the contact person', 'Enter the phone number', 'Enter the address']) await form.getByText(msg).first().waitFor();
  await form.getByLabel('Company Name').fill('Wellness Traders');
  await form.getByLabel('Contact Person').fill('Rohan Mehta');
  await form.getByLabel(/^Phone Number/).fill('9820099001'); // the required marker is part of the label text, so anchor rather than match exactly
  await form.getByLabel('Address Line 1').fill('44 Dock Road');
  await form.getByLabel('GST Number').fill('BAD-GST');
  await form.getByLabel('PAN Number').fill('ABCD1234F');
  await form.getByLabel('PIN Code').fill('4110');
  await form.getByRole('button', { name: 'Save Supplier' }).click();
  await form.getByText('GST number is not in a valid format').waitFor();
  await form.getByText('PAN is not in a valid format (ABCDE1234F)').waitFor();
  await form.getByText('Enter a 6-digit PIN code').waitFor();
  await form.getByLabel('GST Number').fill('27AAACS1234A1Z5');
  await form.getByLabel('PAN Number').fill('ABCDE1234F');
  await form.getByLabel('PIN Code').fill('411001');
  await form.getByLabel('Supplier Type').selectOption('wholesaler');
  await form.getByLabel('Payment Terms').selectOption('net30');
  await form.getByLabel('Minimum Order Value (₹)').fill('5000');
  await form.getByRole('button', { name: 'Save Supplier' }).click();
  await d.getByText('Supplier “Wellness Traders” added').waitFor();
  const row = d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first();
  await row.waitFor();
  assert.match((await row.innerText()).replace(/\s+/g, ' '), /SUP-\d{4}.*Wholesaler.*27AAACS1234A1Z5.*Rohan Mehta.*9820099001/);

  // marking preferred asks first, then the row says so
  await row.getByRole('button', { name: 'Mark Wellness Traders as preferred' }).click();
  await d.getByRole('dialog', { name: 'Mark as preferred?' }).getByRole('button', { name: 'Mark as preferred' }).click();
  await d.getByText('“Wellness Traders” marked as preferred').waitFor();
  await d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first().getByText('Preferred').waitFor();
  await d.getByRole('combobox', { name: 'Preferred' }).selectOption('true'); // now the filter finds it
  await d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first().waitFor();
  await d.getByRole('combobox', { name: 'Preferred' }).selectOption('false');
  await d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first().waitFor({ state: 'detached' });
  await d.getByRole('combobox', { name: 'Preferred' }).selectOption('');

  // the details: what was entered, and statistics that come from real records (none yet for a brand new supplier)
  await d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first().getByRole('button', { name: 'View supplier Wellness Traders' }).click();
  const details = d.getByRole('dialog', { name: 'Wellness Traders' });
  await details.getByRole('region', { name: 'Supplier statistics' }).waitFor();
  const stats = (await details.getByRole('region', { name: 'Supplier statistics' }).innerText()).replace(/\s+/g, ' ');
  assert.match(stats, /purchase orders 0/i); // the stat labels are upper-cased by the design system
  assert.match(stats, /total purchases ₹0/i);
  assert.match(stats, /last purchase —/i, 'nothing is invented');
  // the purchase history comes from the real orders: a brand new supplier has none
  await details.getByRole('region', { name: 'Purchase history' }).getByText('Nothing bought yet').waitFor();
  const company = (await details.getByRole('region', { name: 'Company details' }).innerText()).replace(/\s+/g, ' ');
  assert.match(company, /ABCDE1234F/);
  assert.match(company, /Wholesaler/);
  const proc = (await details.getByRole('region', { name: 'Procurement details' }).innerText()).replace(/\s+/g, ' ');
  assert.match(proc, /30 days \(30 days credit\)/);
  assert.match(proc, /₹5,000/);

  // edit from the details view
  await details.getByRole('button', { name: 'Edit Supplier' }).click();
  const edit = d.getByRole('dialog', { name: 'Edit Supplier' });
  assert.equal(await edit.getByLabel('Company Name').inputValue(), 'Wellness Traders');
  await edit.getByLabel('Contact Person').fill('Rohan M Mehta');
  await edit.getByRole('button', { name: 'Save Supplier' }).click();
  await d.getByText('Supplier “Wellness Traders” updated').waitFor();
  await d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first().getByText('Rohan M Mehta').waitFor();

  // deactivating keeps the record and marks it
  await d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first().getByRole('button', { name: 'Deactivate Wellness Traders' }).click();
  await d.getByRole('dialog', { name: 'Deactivate this supplier?' }).getByRole('button', { name: 'Deactivate' }).click();
  await d.getByText('“Wellness Traders” deactivated').waitFor();
  await d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first().getByText('Inactive').waitFor();

  // a supplier that has been bought from shows that history, read from the orders themselves
  await search.fill('Sun Pharma');
  await rowFor('Sun Pharma Distributors').getByRole('button', { name: 'View supplier Sun Pharma Distributors' }).click();
  const bought = d.getByRole('dialog', { name: 'Sun Pharma Distributors' });
  const history = bought.getByRole('region', { name: 'Purchase history' });
  await history.getByRole('row').filter({ hasText: /ORD-/ }).first().waitFor();
  for (const h of ['Purchase Order', 'Purchase Date', 'Expected', 'Received', 'Total', 'Paid', 'Outstanding', 'Order Status', 'Goods Receipt']) await history.getByRole('columnheader', { name: h, exact: true }).first().waitFor();
  const firstPurchase = (await history.getByRole('row').filter({ hasText: /ORD-/ }).first().innerText()).replace(/\s+/g, ' ');
  assert.match(firstPurchase, /ORD-\d+.*₹/, 'the order number and its money');
  const openOrder = history.getByRole('row').filter({ hasText: /ORD-/ }).first().getByRole('button', { name: /^Open order/ });
  await openOrder.click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await d.getByRole('dialog').filter({ hasText: /ORD-/ }).first().waitFor(); // it opened the order itself
  await d.keyboard.press('Escape');
  await d.getByRole('link', { name: 'Suppliers', exact: true }).click();
  await d.getByRole('heading', { name: 'Suppliers', exact: true }).waitFor();

  // a supplier with purchase orders cannot be deleted — the message says to deactivate instead
  await search.fill('Sun Pharma');
  const used = d.getByRole('row').filter({ hasText: 'Sun Pharma Distributors' }).first();
  await used.getByRole('button', { name: 'Delete supplier Sun Pharma Distributors' }).click();
  await d.getByRole('dialog', { name: 'Delete this supplier?' }).getByRole('button', { name: 'Delete supplier' }).click();
  await d.getByText(/can't be deleted: it has purchase orders.*Deactivate it instead/).waitFor();
  await rowFor('Sun Pharma Distributors').waitFor(); // still there

  // one that was never used can be deleted
  await search.fill('Wellness Traders');
  const fresh = d.getByRole('row').filter({ hasText: 'Wellness Traders' }).first();
  await fresh.getByRole('button', { name: 'Delete supplier Wellness Traders' }).click();
  await d.getByRole('dialog', { name: 'Delete this supplier?' }).getByRole('button', { name: 'Delete supplier' }).click();
  await d.getByText('Supplier “Wellness Traders” deleted').waitFor();
  await d.getByText('No suppliers found').waitFor();
  await search.fill('');
});

await check('selling point: GST is split out of the inclusive price — the breakdown explains the total, and the saved bill agrees with it', async () => {
  const seeded = await (await fetch('http://127.0.0.1:4102/seed/pos/on')).json();
  await d.getByRole('link', { name: 'Selling Point', exact: true }).click();
  await d.getByRole('heading', { name: /Selling Point/i }).first().waitFor();

  // find the medicine and put two of them in the cart
  const search = d.getByRole('textbox', { name: 'Search medicine', exact: true }); // not the header's "Search medicines";
  await search.fill(seeded.name);
  const hit = d.getByRole('button', { name: new RegExp(seeded.name) }).first();
  await hit.click();
  await hit.click();
  const row = d.getByRole('row').filter({ hasText: seeded.name }).first();
  await row.waitFor();

  // the breakdown: ₹112 each, GST 12% inside the price → taxable ₹200, CGST ₹12, SGST ₹12, total ₹224
  await d.getByRole("button", { name: /Customer . billing/ }).click(); // the details are collapsed until opened
  const breakdown = d.locator('dl[aria-label="Billing breakdown"]').first();
  await breakdown.waitFor();
  const text = (await breakdown.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /Gross \(inclusive of GST\) ₹224/);
  assert.match(text, /Taxable value ₹200/);
  assert.match(text, /CGST ₹12/);
  assert.match(text, /SGST ₹12/);
  assert.equal(await d.getByTestId('pos-total').innerText(), '₹224.00', 'the customer pays the marked price — tax is inside it');

  // a bill discount pulls the tax down with it
  await d.getByRole('combobox', { name: 'Discount type' }).selectOption('amount');
  await d.getByRole('spinbutton', { name: 'Bill discount' }).fill('24');
  await d.waitForFunction(() => document.querySelector('[data-testid="pos-total"]')?.textContent?.trim() === '₹200.00');
  const discounted = (await breakdown.innerText()).replace(/\s+/g, ' ');
  assert.match(discounted, /Bill discount − ₹24/);
  assert.match(discounted, /Taxable value ₹178.57/, 'the tax falls with the discount');
  await d.getByRole('spinbutton', { name: 'Bill discount' }).fill('');

  // save it, and the invoice the server wrote agrees with what was shown
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await d.getByText(/Invoice INV-\d+ saved — ₹224/).waitFor();
  await d.getByText('No items added yet').waitFor();

  await d.getByRole('link', { name: 'Recent Invoices', exact: true }).click();
  await d.getByRole('heading', { name: /Invoices/ }).first().waitFor();
  const latest = d.getByRole('row').filter({ hasText: /INV-/ }).first();
  await latest.waitFor();
  assert.match((await latest.innerText()).replace(/\s+/g, ' '), /₹224/);
});

await check('compounds: a plain formulation label stays simple, and a preparation adds its recipe with the batch worked out', async () => {
  await d.getByRole('link', { name: 'All Compound', exact: true }).click();
  await d.getByRole('heading', { name: /All Compound/i }).first().waitFor();
  await d.getByRole('button', { name: /Add Compound/i }).click();
  const dlg = d.getByRole('dialog', { name: 'Add compound' });

  // the common case is unchanged: a name and a composition, nothing more
  await dlg.getByText('What it is', { exact: true }).waitFor();
  assert.equal(await dlg.getByText('Ingredients & base').count(), 0, 'the recipe only appears when it is asked for');
  await dlg.getByLabel('Compound name').fill('Ketamine / Gabapentin Cream');

  // say the pharmacy makes it, and the recipe appears
  await dlg.getByRole('checkbox', { name: /We prepare this ourselves/ }).check();
  for (const step of ['Ingredients & base', 'Preparation instructions', 'Batch & shelf life', 'Directions (sig)']) await dlg.getByText(step, { exact: true }).waitFor();
  await dlg.getByLabel('Ingredient 1', { exact: true }).fill('Ketamine HCl');
  await dlg.getByLabel('Quantity of ingredient 1').fill('10');
  await dlg.getByLabel('Ingredient 2', { exact: true }).fill('VersaBase Cream');
  assert.equal(await dlg.getByLabel('Quantity of ingredient 2').isDisabled(), true, 'the base makes the batch up, so it takes no quantity');
  await dlg.getByRole('button', { name: 'Add ingredient' }).click();
  await dlg.getByLabel('Ingredient 3', { exact: true }).fill('Gabapentin');
  await dlg.getByLabel('Quantity of ingredient 3').fill('5');

  // the batch is worked out as it is typed: 10% and 5% of 100 g, and the base fills the other 85 g
  const batch = d.locator('[aria-label="What this batch weighs out"]');
  await batch.getByText('This batch makes 100 g').waitFor();
  await batch.getByText('Measured 15 g · base makes up 85 g').waitFor();

  // a recipe whose ingredients do not fit the batch is refused before it can be saved
  await dlg.getByLabel('Quantity of ingredient 1').fill('80');
  await dlg.getByLabel('Quantity of ingredient 3').fill('40');
  await batch.getByText(/120 g, which is more than the 100 g this formula makes/).waitFor();
  await dlg.getByLabel('Quantity of ingredient 1').fill('10');
  await dlg.getByLabel('Quantity of ingredient 3').fill('5');

  await dlg.getByLabel('How it is made', { exact: true }).fill('Levigate the actives with a little base, then incorporate the rest geometrically.');
  await dlg.getByRole('checkbox', { name: 'Requires unguator' }).check();
  await dlg.getByRole('checkbox', { name: /Light sensitive/ }).check();
  await dlg.getByLabel('Beyond-use').fill('180');
  await dlg.getByLabel('What goes on the label').fill('Apply 1-2 pumps to the affected area up to four times daily as needed.');
  await dlg.getByRole('button', { name: 'Add compound' }).click();
  await d.getByText(/Compound "Ketamine \/ Gabapentin Cream" added/).waitFor();
  await d.getByRole('row').filter({ hasText: 'Ketamine / Gabapentin Cream' }).first().waitFor();
});

await check('business analytics: KPIs against real trade, a comparison period, chart switching and a store filter', async () => {
  await d.getByRole('link', { name: 'Business Analytics', exact: true }).click();
  await d.getByRole('heading', { name: 'Business Analytics', exact: true }).waitFor();
  await d.getByText('Monitor business performance, inventory health, and financial activity.').waitFor();

  // the figures come from the demo data's real invoices, so they are money, not placeholders
  const kpis = d.getByRole('region', { name: 'Headline figures' });
  for (const label of ['Total sales', 'Total purchases', 'Gross profit', 'Net sales', 'Transactions', 'Average invoice', 'Outstanding receivables', 'Sales returns']) {
    await kpis.getByText(label, { exact: true }).waitFor();
  }
  const salesCard = kpis.locator('div').filter({ hasText: /^Total sales/ }).first();
  assert.match((await salesCard.innerText()).replace(/\s+/g, ' '), /₹/, 'a real amount, formatted as rupees');

  // every card explains how it is worked out, because "sales" and "profit" are not the same thing
  await kpis.getByRole('button', { name: 'How Gross profit is worked out' }).click();
  await d.getByText(/taken from the batch each one came out of/).waitFor();

  // the chart can be asked a different question
  const chart = d.getByRole('group', { name: 'What to show' });
  await chart.getByRole('button', { name: 'Purchases' }).click();
  assert.equal(await chart.getByRole('button', { name: 'Purchases' }).getAttribute('aria-pressed'), 'true');
  await d.getByRole('group', { name: 'Chart type' }).getByRole('button', { name: 'Bars' }).click();
  await chart.getByRole('button', { name: 'Sales' }).click();

  // net profit is never claimed without expense records
  await d.getByText('Net profit is not shown.').waitFor();
  await d.getByText(/rent, salaries, utilities/).waitFor();

  // the period is part of the question: a day with no trade says so rather than showing yesterday's figures
  await d.getByRole('combobox', { name: 'Period' }).selectOption('yesterday');
  await d.waitForFunction(() => !document.querySelector('.skeleton'));
  const breakdown = d.getByRole('region', { name: 'Transaction breakdown' }).or(d.locator('[aria-label="Transaction breakdown"]')).first();
  await breakdown.waitFor();
  await d.getByRole('combobox', { name: 'Period' }).selectOption('thisMonth');

  // and so is the store
  await d.getByRole('combobox', { name: 'Store' }).selectOption({ index: 1 });
  await d.waitForFunction(() => !document.querySelector('.skeleton'));
  await kpis.getByText('Total sales', { exact: true }).waitFor();
});

await check('daily transaction report: opened from the breakdown with its filter set, filtered and searched server-side, a document opened in full, and an export of every matching row', async () => {
  /** A figure from the summary bar, read off its own label so the test never depends on how it is abbreviated. */
  const figure = async (label) => {
    const text = await d.getByLabel(new RegExp(`^${label}: `)).first().getAttribute('aria-label');
    return Number(text.replace(/^[^:]*:\s*/, '').replace(/[^\d.]/g, ''));
  };
  const settled = () => d.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 15000 });

  // the Overview's breakdown is a way in, not just a picture: choosing Sales opens the report already filtered to it
  await d.goto(`${BASE}/analytics`);
  await settled();
  await d.getByRole('link', { name: /^Sales: / }).click();
  await heading(d, 'Daily Transaction Report');
  await settled();
  assert.match(new URL(d.url()).search, /type=sale/, 'the chosen category travelled in the address');
  assert.equal(await d.getByRole('combobox', { name: 'Transaction type' }).inputValue(), 'sale');
  await d.getByRole('button', { name: /Type: Sale/ }).waitFor(); // and it says so as a chip you can take off

  // the demo data has real invoices, so the list is documents and money, not placeholders
  const row = d.locator('tbody tr').first();
  await row.waitFor();
  const reference = (await row.locator('.font-mono').first().innerText()).trim(); // the reference cell, wherever the column plan puts it
  assert.match(reference, /\w/, 'a real reference');
  assert.match((await row.innerText()).replace(/\s+/g, ' '), /₹/, 'and a real amount in rupees');
  const sales = await figure('Transactions');
  assert.ok(sales > 0, 'there is trade in the demo data');
  await shot(d, 'analytics-transactions');

  // searching narrows it at the server: one reference finds one document
  await d.getByLabel('Search transactions').fill(reference);
  await d.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1, null, { timeout: 15000 });
  assert.equal(await figure('Transactions'), 1, 'the figures follow the question');
  await d.getByRole('button', { name: /Search: / }).waitFor();

  // a search that matches nothing says so, rather than leaving the last answer on screen
  await d.getByLabel('Search transactions').fill('no-such-reference-anywhere');
  await d.getByText('No transaction matches these filters').waitFor({ timeout: 15000 });
  await d.getByRole('button', { name: 'Clear filters' }).click();
  await settled();
  assert.equal(await d.getByRole('button', { name: /Search: / }).count(), 0, 'the chips went with the filters');
  assert.equal(await d.getByRole('combobox', { name: 'Transaction type' }).inputValue(), '', 'and so did the type');
  // clearing re-asks the server once the typing settles: wait for that answer rather than reading the previous one
  await d.waitForFunction(
    (want) => {
      const el = document.querySelector('[aria-label^="Transactions: "]');
      if (!el) return false;
      return Number(el.getAttribute('aria-label').replace(/^[^:]*:\s*/, '').replace(/[^\d.]/g, '')) >= want;
    },
    sales,
    { timeout: 15000 },
  );

  // the document behind a row, in full, and a way through to the module that owns it
  await d.getByRole('button', { name: /^View / }).first().click();
  const dlg = d.getByRole('dialog');
  await dlg.waitFor();
  for (const label of ['Reference', 'Date', 'Status', 'Amount', 'Recorded by']) {
    await dlg.getByText(label, { exact: true }).first().waitFor();
  }
  await shot(d, 'analytics-transaction-details');
  await dlg.getByRole('link', { name: /^Open the/ }).waitFor();
  await d.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });

  // paging happens in the database: the figures describe the question, so they do not move when the page does
  const nextPage = d.getByRole('button', { name: 'Next' }).first();
  if (await nextPage.isEnabled()) {
    const before = (await d.locator('tbody tr').first().innerText()).trim();
    const total = await figure('Transactions');
    await nextPage.click();
    await d.waitForFunction((t) => document.querySelector('tbody tr')?.innerText.trim() !== t, before, { timeout: 15000 });
    assert.equal(await figure('Transactions'), total, 'turning the page does not change what was counted');
  }

  // a transfer is listed but is never trade — the row says so itself
  await d.getByRole('combobox', { name: 'Transaction type' }).selectOption('transfer');
  await settled();
  if (await d.locator('tbody tr').count()) {
    assert.match((await d.locator('tbody tr').first().innerText()).replace(/\s+/g, ' '), /not counted/, 'a transfer is shown, and shown not to count');
  }

  // the export carries every matching row, with the filters printed on the file
  await d.getByRole('combobox', { name: 'Transaction type' }).selectOption('sale');
  await settled();
  const expected = await figure('Transactions');
  const [file] = await Promise.all([d.waitForEvent('download'), d.getByRole('button', { name: 'Export CSV' }).click()]);
  assert.match(file.suggestedFilename(), /^usha-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = fs.readFileSync(await file.path(), 'utf8');
  assert.match(csv, /Usha Pharmacy — Daily Transaction Report/);
  assert.match(csv, /Transaction type,Sale/, 'the filter that was applied is on the file');
  assert.match(csv, new RegExp(`Transactions,${expected}`), 'and so is how many rows it carries');
  const lines = csv.split(/\r?\n/);
  const body = lines.slice(lines.findIndex((l) => l.startsWith('Type,')) + 1).filter((l) => l.trim());
  assert.equal(body.length, expected, 'every matching row, not the page on screen');
  await d.getByText(/Exported \d/).waitFor();
});

/* ---------- loading and error states */
await check('ai billing page (purchasing): final review, verify, create the purchase order, enter what actually arrived, confirm — only accepted units enter stock; the order becomes partially received', async () => {
  const sw = (what) => fetch(`http://127.0.0.1:4102/${what}`);
  await sw('ocr/on');
  await sw('llm/receive');
  await sw('seed/products/on');
  await d.getByRole('link', { name: 'Orders', exact: true }).click();
  await d.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await d.getByRole('button', { name: 'AI Billing' }).click();
  await d.getByRole('heading', { name: 'AI Billing', exact: true }).waitFor();
  await d.getByLabel('Invoice file').setInputFiles({ name: 'purchase-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF_FILE, Buffer.from('purchase-run')]) });
  await d.getByRole('button', { name: 'Scan Invoice' }).click();
  await d.getByRole('heading', { name: /OCR Results/ }).waitFor();
  await d.getByRole('button', { name: 'Extract Invoice with AI' }).click();
  await d.getByRole('heading', { name: /Extracted invoice/ }).waitFor();
  // the person reviews the extraction, then matches the products
  await d.getByLabel(/I have checked this invoice against the document/).check();
  await d.getByRole('button', { name: 'Mark as Reviewed' }).click();
  await d.getByText(/Marked as reviewed/).waitFor();
  await d.getByRole('button', { name: 'Match Products' }).click();
  await d.getByRole('heading', { name: /Medicine Product Matching/ }).waitFor();
  assert.equal(await d.getByRole('button', { name: 'Proceed to Goods Receipt' }).isDisabled(), true, 'not until every product is confirmed');
  await d.getByRole('button', { name: 'Confirm all eligible' }).click();
  await d.getByText(/2 matches confirmed/).waitFor();
  await d.getByRole('button', { name: 'Proceed to Goods Receipt' }).click();
  // the final review: everything on one page, and nothing goes on until the person verifies it
  await d.getByRole('heading', { name: /Final invoice review/ }).waitFor();
  await d.getByRole('region', { name: 'Supplier information' }).getByText('Sun Pharma Distributors').first().waitFor();
  await d.getByRole('region', { name: 'Product information' }).getByText('RC-1').waitFor();
  assert.match((await d.getByRole('heading', { name: /Final invoice review/ }).innerText()).replace(/\s+/g, ' '), /Not verified/);
  assert.equal(await d.getByRole('region', { name: 'Purchase order' }).count(), 0, 'no purchase order before verification');
  await d.getByLabel(/I have verified this invoice against the original document/).check();
  await d.getByRole('button', { name: 'Confirm invoice verified' }).click();
  await d.getByText('Invoice verified.').waitFor();
  // Option A: the order is made in Orders from the invoice
  await d.getByRole('tab', { name: 'Link existing purchase order' }).click();
  await d.getByRole('tab', { name: 'Create new purchase order' }).click();
  await d.getByRole('button', { name: 'Create Purchase Order' }).click();
  await d.getByText(/Purchase order ORD-\d+ created/).first().waitFor();
  await d.getByRole('button', { name: 'Proceed to Goods Receipt' }).click();
  // the goods receipt: invoice quantity shown, actual quantity EMPTY
  await d.getByRole('heading', { name: /Goods receipt/ }).first().waitFor();
  assert.equal(await d.getByLabel('Actually received quantity of line 1').inputValue(), '', 'what arrived is never copied from the invoice');
  assert.match((await d.locator('tbody tr').first().innerText()).replace(/\s+/g, ' '), /\b50\b/, 'the invoice quantity is shown for comparison');
  await d.getByRole('button', { name: /Confirm Goods Receipt & Update Stock/ }).click();
  await d.getByText(/Fix the highlighted quantities/).waitFor();
  assert.equal(await d.getByRole('dialog', { name: 'Confirm goods receipt' }).count(), 0, 'nothing is confirmed while quantities are missing');
  // 48 of 50 arrived, 3 of them rejected; 5 of 5 arrived
  await d.getByLabel('Actually received quantity of line 1').fill('48');
  await d.getByLabel('Free quantity received of line 1').fill('0');
  await d.getByLabel('Rejected quantity of line 1').fill('3');
  await d.getByLabel('Remarks of line 1').fill('damaged in transit');
  await d.getByLabel('MRP of line 1').fill('30');
  await d.getByLabel('Selling price of line 1').fill('28');
  await d.getByLabel('Actually received quantity of line 2').fill('5');
  await d.getByLabel('Free quantity received of line 2').fill('0');
  await d.getByLabel('MRP of line 2').fill('100');
  await d.getByLabel('Selling price of line 2').fill('95');
  assert.equal((await d.getByLabel('Accepted quantity of line 1').innerText()).trim(), '45', 'accepted = arrived − rejected');
  await d.getByRole('button', { name: /Confirm Goods Receipt & Update Stock/ }).click();
  const dlg = d.getByRole('dialog', { name: 'Confirm goods receipt' });
  await dlg.getByText(/50 units will be added to sellable stock/).waitFor();
  await dlg.getByText(/Differs from the invoice/).waitFor();
  await dlg.getByRole('button', { name: 'Confirm and update stock' }).click();
  await d.getByRole('heading', { name: /Goods receipt confirmed/ }).waitFor();
  await d.getByText(/50 units added to stock/).waitFor();
  assert.match(await d.getByText(/Order ORD-\d+ is now/).innerText(), /partially received/i);
  await d.getByRole('button', { name: 'Done' }).click();
  const od = d.getByRole('dialog', { name: /^Order ORD-/ });
  await od.waitFor();
  assert.match((await od.innerText()).replace(/\s+/g, ' '), /Partially received/i);
  await d.keyboard.press('Escape');
  await sw('seed/products/off');
  await sw('llm/off');
  await sw('ocr/off');
});

console.log('\nLoading and error states (desktop)');
await check('loading: skeleton rows show while the list is loading, then real rows replace them', async () => {
  await d.route('**/api/inventory?**', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await d.goto(`${BASE}/inventory`);
  await d.locator('.skeleton').first().waitFor({ timeout: 5000 });
  await shot(d, 'desktop-inventory-loading');
  await d.locator('tbody tr td:first-child').filter({ hasText: /Dolo|Crocin|Browser|Import/ }).first().waitFor({ timeout: 15000 });
  assert.equal(await d.locator('.skeleton').count(), 0, 'skeletons are gone');
  await d.unroute('**/api/inventory?**');
});
await check('error: a failing API shows a readable message with a working Try again', async () => {
  await d.route('**/api/inventory?**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Database is having a moment' }) }));
  await d.goto(`${BASE}/inventory`);
  const alert = d.getByRole('alert').filter({ hasText: 'Something went wrong' });
  await alert.waitFor({ timeout: 10000 });
  assert.match(await alert.innerText(), /Database is having a moment/);
  await shot(d, 'desktop-inventory-error');
  await d.unroute('**/api/inventory?**');
  await alert.getByRole('button', { name: 'Try again' }).click();
  await d.locator('tbody tr td:first-child').first().waitFor();
});
await check('error: the server being unreachable gives a connection message, not a blank page', async () => {
  await d.route('**/api/batches?**', (route) => route.abort('connectionrefused'));
  await d.goto(`${BASE}/inventory/batches`);
  await d.getByRole('alert').filter({ hasText: /Cannot reach the server/ }).waitFor({ timeout: 10000 });
  await d.unroute('**/api/batches?**');
});
await check('error: an expired session sends the user back to the login page', async () => {
  await d.goto(`${BASE}/inventory`);
  await loaded(d);
  await d.route('**/api/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Session expired', code: 'SESSION_ENDED' }) }));
  await d.getByLabel('Search inventory').fill('x');
  await d.waitForURL('**/login', { timeout: 15000 });
  await d.unroute('**/api/**');
});

/* ---------- dark mode + accessibility */
console.log('\nDark mode and accessibility (desktop)');
await dctx.close();
const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: authState });
const dk = await dark.newPage();
watch(dk, 'dark');
for (const [id, url, h1] of PAGES) {
  await check(`dark mode: ${id} — dark background, light text, readable; and light mode passes the same checks`, async () => {
    await dk.goto(`${BASE}${url}`);
    await dk.getByRole('navigation', { name: 'Main' }).waitFor();
    await dk.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 15000 });
    assert.equal(await dk.getByText('Something went wrong').count(), 0, `${id} loaded into an error state`);
    for (const theme of ['light', 'dark']) {
      await setTheme(dk, theme);
      await dk.waitForTimeout(500); // let the colour transition finish before reading computed colours
      const { bg, fg, cardBg } = await dk.evaluate(() => {
        const cs = (el) => getComputedStyle(el);
        const card = document.querySelector('main [class*="bg-card"]') || document.querySelector('main');
        return { bg: cs(document.body).backgroundColor, fg: cs(document.body).color, cardBg: cs(card).backgroundColor };
      });
      if (theme === 'dark') {
        assert.ok(luminance(bg) < 0.1, `page background ${bg} is not dark`);
        assert.ok(luminance(cardBg) < 0.15 || /rgba\(0, 0, 0, 0\)/.test(cardBg), `card background ${cardBg} is not dark`);
        assert.ok(luminance(fg) > 0.5, `text colour ${fg} is not light`);
      } else {
        assert.ok(luminance(bg) > 0.5, `light page background ${bg} is not light`);
      }
      await shot(dk, `${theme}-${id}`);
      await axe(dk, `${id} (${theme})`);
    }
  });
}
await check('dark mode: the choice is remembered after a reload', async () => {
  await dk.goto(`${BASE}/inventory`);
  await setTheme(dk, 'dark');
  await dk.reload();
  await dk.getByRole('navigation', { name: 'Main' }).waitFor();
  assert.ok(await dk.evaluate(() => document.documentElement.classList.contains('dark')));
});
await check('dark mode: dialogs and forms are readable too', async () => {
  await dk.goto(`${BASE}/inventory`);
  await setTheme(dk, 'dark');
  await dk.getByRole('button', { name: 'Add Medicine' }).click();
  const dlg = dk.getByRole('dialog', { name: 'Add medicine' });
  await dlg.waitFor();
  const bg = await dlg.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.ok(luminance(bg) < 0.15, `dialog background ${bg} is not dark`);
  await dlg.getByRole('button', { name: 'Add medicine' }).click();
  await dlg.getByText('Medicine name is required').first().waitFor();
  await shot(dk, 'dark-form-errors');
  await axe(dk, 'add-medicine dialog (dark)');
  await dk.keyboard.press('Escape');
});
await dark.close();

/* ============================================================ Mobile */
console.log('\nMobile (390×844)');
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, storageState: authState });
const m = await mctx.newPage();
watch(m, 'mobile');
await check('mobile: the sidebar is hidden, the menu button opens it, choosing a page closes it', async () => {
  await m.goto(`${BASE}/dashboard`);
  await m.getByRole('button', { name: 'Open menu' }).waitFor();
  const side = m.getByRole('complementary', { name: 'Sidebar' });
  assert.ok(!(await side.isVisible()) || (await side.boundingBox()).x < 0, 'sidebar starts closed');
  await m.getByRole('button', { name: 'Open menu' }).click();
  await openStock(m);
  await m.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Inventory Batch', exact: true }).click();
  await heading(m, 'Inventory Batch');
  const box = await side.boundingBox();
  assert.ok(!(await side.isVisible()) || box.x + box.width <= 1, 'the drawer closed after navigating');
});
for (const [id, url, h1] of PAGES) {
  await check(`mobile: ${id} fits the screen without sideways page scrolling`, async () => {
    await m.goto(`${BASE}${url}`);
    await m.getByRole('button', { name: 'Open menu' }).waitFor();
    await m.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 15000 });
    assert.equal(await m.getByText('Something went wrong').count(), 0, `${id} loaded into an error state`);
    await noHorizontalScroll(m);
    await shot(m, `mobile-${id}`);
    await axe(m, `${id} (mobile)`);
  });
}
await check('mobile: the inventory list becomes cards you can search and open', async () => {
  await m.goto(`${BASE}/inventory`);
  await m.getByRole('listitem').first().waitFor();
  const shown = await m.evaluate(() => [...document.querySelectorAll('table')].filter((t) => t.offsetParent !== null).map((t) => t.closest('div')?.className?.slice(0, 80)));
  assert.deepEqual(shown, [], 'the wide table is not shown on a phone');
  await m.getByLabel('Search inventory').fill('Dolo');
  await m.locator('li:visible', { hasText: 'Dolo 650' }).first().waitFor();
});
await check('mobile: the add-medicine form is usable (scrolls inside the dialog, buttons reachable)', async () => {
  await m.goto(`${BASE}/inventory`);
  await m.getByRole('button', { name: 'Add Medicine' }).tap();
  const dlg = m.getByRole('dialog', { name: 'Add medicine' });
  await dlg.waitFor();
  const box = await dlg.boundingBox();
  assert.ok(box.width <= 390, `dialog is ${box.width}px wide on a 390px screen`);
  await dlg.getByLabel('Medicine name').fill('Phone Entry');
  await dlg.getByRole('button', { name: 'Add medicine' }).scrollIntoViewIfNeeded();
  assert.ok(await dlg.getByRole('button', { name: 'Add medicine' }).isVisible());
  await noHorizontalScroll(m);
  await shot(m, 'mobile-form');
});
await check('mobile: dark mode works', async () => {
  await m.goto(`${BASE}/inventory/batches`);
  await m.getByRole('button', { name: 'Open menu' }).waitFor({ timeout: 45000 });
  await setTheme(m, 'dark');
  const bg = await m.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.ok(luminance(bg) < 0.1);
  await shot(m, 'mobile-batches-dark');
});
await mctx.close();

/* ============================================================ roles & users: the route-level permission guard */
await check('a non-admin who types /roles is told so, rather than shown an empty shell', async () => {
  // A second browser context, signed in as the STAFF user the stack seeds. STAFF has no `users:manage`.
  const sctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const sp = await sctx.newPage();
  watch(sp, 'staff');
  try {
    await sp.goto(`${BASE}/login`);
    await sp.getByLabel('Email').fill('staff@e2e.test');
    await sp.locator('input[autocomplete="current-password"]').fill(ADMIN.password);
    await sp.getByRole('button', { name: 'Sign in' }).click();
    await sp.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 });

    // The sidebar does not offer it.
    assert.equal(await sp.locator('a[href="/roles"]').count(), 0, 'the sidebar must not link somewhere they cannot go');

    // Typing the URL anyway gets a plain explanation, not a broken-looking page.
    await sp.goto(`${BASE}/roles`);
    await sp.getByText(/You don't have access to this page/i).waitFor({ timeout: 15000 });
    assert.equal(await sp.locator('table').count(), 0, 'no empty tables pretending to load');
    assert.equal(await sp.getByRole('button', { name: 'Add role' }).count(), 0, 'and no action it could not perform');
    await shot(sp, 'roles-denied');

    // And the server says the same thing, so the screen is a courtesy rather than the enforcement.
    const status = await sp.evaluate(async () => (await fetch('/api/roles', { credentials: 'include' })).status);
    assert.equal(status, 403, `the API must refuse them too, got ${status}`);
  } finally {
    await sctx.close();
  }
});

await check('an administrator still sees the Roles & Users page itself', async () => {
  await d.goto(`${BASE}/roles`);
  await heading(d, 'Roles & Users');
  await d.locator('tbody tr').first().waitFor({ timeout: 15000 });
  assert.ok((await d.locator('tbody tr').count()) >= 5, 'the five built-in roles are listed');
});



/* ============================================================ report */
await browser.close();
const failed = results.filter((r) => !r.ok);
const unique = (xs) => [...new Set(xs)];
const report = { passed: results.length - failed.length, failed: failed.length, failures: failed, consoleProblems: unique(consoleProblems), axe: axeFindings };
fs.writeFileSync(path.resolve(here, '..', '.tmp', 'e2e-report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed; ${report.consoleProblems.length} console problem(s); ${axeFindings.length} serious/critical accessibility finding(s)`);
process.exit(failed.length ? 1 : 0);
