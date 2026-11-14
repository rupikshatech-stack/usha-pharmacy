# Usha Pharmacy — Wholesale ERP

Multi-tenant wholesale pharmacy ERP. React + Vite + Tailwind on the front, Express + MongoDB (Mongoose) on the back.

```
usha-pharmacy/
├── client/   React app (Vite, Tailwind 4, React Router, Axios, Recharts)
│   └── src/  components/{common,layout,dashboard,inventory}  context  hooks  layouts
│             pages/{auth,dashboard,inventory,sales,system}  routes  services  utils
├── server/   Express API
│   ├── config/       env (validated), db, cors
│   ├── controllers/  thin request handlers
│   ├── services/     business logic (stock, invoices, dashboard, audit, transactions)
│   ├── validators/   zod request schemas
│   ├── middleware/   auth, validation, error handling
│   ├── models/       Mongoose models (every tenant record has organizationId)
│   ├── routes/       URL wiring
│   ├── scripts/      one-off scripts (seed)
│   ├── app.js        Express app    server.js   entry point
└── package.json      root scripts to run everything
```

## Requirements
Node.js 20+. MongoDB is **optional in development** (an embedded replica set is started automatically);
production needs a replica set such as MongoDB Atlas, because stock/billing use transactions.

## Setup
```
npm run install:all
cp server/.env.example server/.env      # then edit: set ADMIN_INITIAL_PASSWORD (and JWT_SECRET)
cp client/.env.example client/.env.local   # optional in development
npm run seed                            # creates the first organization + administrator
```
`npm run seed` is separate from the server and safe to repeat: it never overwrites or duplicates an
existing account. With `ADMIN_REQUIRE_PASSWORD_CHANGE=true` the administrator must choose a new
password at first sign-in.

## Run
```
npm run dev            # API (nodemon, :4000) and web app (Vite, :5173) together
npm run dev:server     # API only
npm run dev:client     # web app only
npm run build          # production build of the client
npm start              # API in production mode
npm run lint
```
Open http://localhost:5173. Health check: `GET http://localhost:4000/api/health`.

## Configuration
All settings are environment variables, validated at startup (the server exits with a clear message
naming any invalid variable). See `server/.env.example` and `client/.env.example`.
Per-environment files `server/.env.development` / `.env.production` are also read; real environment
variables always win. **Never commit `.env` files** (they are git-ignored).

## Multi-tenant architecture
Each pharmacy business is an **Organization** (name, unique `slug`, email, phone, address, GSTIN, logo,
status). Every business record (medicines, batches, invoices, stock movements, audit log, counters)
carries an `organizationId`, and users belong to exactly one organization.

Isolation has three layers:
1. **`requireTenant` middleware** (`server/middleware/tenant.js`) — after authentication it reads the
   organization from the signed-in user's *database record* (never from the request), rejects users with no
   membership / a missing or suspended organization / `SUPER_ADMIN`, and runs the rest of the request inside
   that tenant context. Standard guard for routes: `router.use(...tenantGuard)`.
2. **Mongoose tenant plugin** (`server/models/plugins/tenantScope.js`) — inside a tenant context it
   *forces* every query, aggregate, update and save onto that organization, refuses documents or filters
   for another one, and **throws if a business model is used with no tenant context** (fail closed).
   `unscoped(fn)` is the explicit, greppable escape hatch.
3. **Explicit `organizationId` filters** in the services, as before.

Other rules: unique business keys are per tenant (batch numbers, invoice numbers); all tenant indexes are
compound and start with `organizationId`; sign-in finds the user by their (globally unique) email and then
works inside that user's tenant.

**Roles:** `SUPER_ADMIN` (reserved, platform-level, no organization), `ORG_ADMIN`, `BRANCH_MANAGER`,
`INVENTORY_MANAGER`, `BILLING_STAFF`, `STAFF`. Each role has default permissions (`config/permissions.js`);
a user can be granted extra ones. Routes use `requirePermission('inventory:write')` etc.

**Tests:** `npm test` (in `server/`) runs the isolation suite on a throwaway database: Organization A cannot
read, modify or delete Organization B's records (by id, search, aggregates, spoofed ids/headers/tokens,
concurrent requests), plus model-level and middleware tests.

**Upgrading an existing database:** `npm run migrate` (idempotent) adds slugs and profile fields, converts
`status` → `isActive`, renames the old roles and syncs indexes.

## Inventory
- **Medicine** = the product (name, generic name, salt, manufacturer, `categoryId`, dosage form, strength, pack size,
  unit, HSN, `gstPercentage`, barcode, SKU, `reorderLevel`, description, image, `isActive`). It stores **no stock**.
- **Batch** = one received lot, with its own expiry and prices (`batchNumber`, `expiryDate`, `purchasePrice`,
  `sellingPrice`, `mrp`, `initialQuantity`, `availableQuantity`, `reservedQuantity`, `branchId`, `supplierId`, `status`).
  A medicine has many batches. Identity fields and `initialQuantity` can never change; batches are **never
  deleted** (archive them once empty). `DELETE /api/inventory/:id` is a **soft delete**: a medicine with batches or
  sales is archived (`isActive=false`, hidden from sale, restorable with `POST /:id/restore`); only one that never had
  any history is physically deleted.
- **Stock status** (calculated from batch data, per medicine): `in_stock` (sellable ≥ reorder level), `low_stock`
  (sellable > 0 but below it), `out_of_stock` (nothing on hand), `expired` (units on hand, all of them expired).
  `GET /api/inventory` supports search (name, salt, manufacturer, SKU, barcode, batch), category / stock-status /
  manufacturer filters, `archived=include|only`, sorting and server-side paging. (`/api/medicines` is the same API.)
- **Stock is calculated** from batches: Σ (`availableQuantity − reservedQuantity`) over batches that are `active` and
  **not expired**. Expired, quarantined, recalled and reserved units are never sellable.
- **Stock ledger** (`StockMovement`): append-only. Every change (receipt, sale, adjustment, write-off; transfers
  are modelled) writes an entry with the running balance, in the same **transaction** as the batch change. Entries
  can't be edited or deleted (the model refuses it); corrections are new entries. `GET /api/stock/reconciliation`
  proves the ledger adds up to every batch. Stock can never go negative — the guard is part of the update itself,
  so simultaneous sales/adjustments can't overdraw a batch.
- **Compounds** and **Attributes** (categories, dosage forms, strengths, units) are per-organization lists with
  CRUD at `/api/compounds` and `/api/attributes`. A category is an Attribute; a medicine points to it by `categoryId`.
- Endpoints: `/api/medicines` (+ `/:id/batches`), `/api/stock/adjustments`, `/api/stock/movements`,
  `/api/stock/reconciliation`. Barcode and SKU are unique per organization. All changes are audited.
- **Inter Store Transfer** (`/inventory/transfers`, API `/api/transfers` and `/api/branches`): move stock between the
  organization's stores. *Stores:* every organization has a default "Main Store" (created automatically); more can be
  added under "Manage stores" (settings permission). A batch is held in exactly one store (`Batch.branchId`; a missing
  value means the default store), and the same lot can exist in several stores — batch-number uniqueness is per
  medicine **and store**. A batch's store can't be edited; stock changes store only through a transfer.
  *Workflow:* **draft** (editable, deletable) → **submit** → **approve** (or **reject**, with a reason, which is final)
  → **dispatch** → **receive**. When the organization does not require approval (the default), submit approves
  automatically. "Require approval for transfers" is switched on under "Manage stores" (settings permission; `PUT
  /api/transfers/settings`). Stock moves only at two steps: **dispatch** takes the units out of the source store's
  batches (ledger `TRANSFER_OUT`; status *in transit*) and **receive** adds them to the same lot in the destination store
  — its batch is created if needed (ledger `TRANSFER_IN`; status *completed*). Availability is checked at submit and again
  at dispatch. A transfer can be **cancelled** until it is received: before dispatch nothing has moved; after it, the units
  return to the source store. Only a draft can be edited or deleted. Each step is one database transaction, claimed
  atomically (it can happen only once, even with simultaneous clicks), never takes a batch below zero or below its
  reserved units, refuses expired / quarantined / recalled / archived stock, and rolls back completely if any line fails.
  Totals are conserved, so `/api/stock/reconciliation` stays consistent. References are per organization (`TRF-0001` …);
  every step is audited and shown in the transfer's history. *Page:* four summary cards from the database (Total, Pending =
  awaiting approval or dispatch, In Transit, Completed — click one to filter); search by reference (also medicine and batch
  number); filters for from-store, to-store, status and date range (`dateFrom` / `dateTo`, both days included); the table
  shows serial number, reference, stores, number of items, date, created by, status and View / Edit / Delete-or-Cancel /
  Print. *Document:* Print opens a printable transfer note (only the note is printed; choose "Save as PDF" in the print
  dialog) and can be downloaded as CSV. *Permissions:* `transfer:manage` prepares, submits, receives and cancels, and
  `transfer:dispatch` dispatches (both: ORG_ADMIN, BRANCH_MANAGER, INVENTORY_MANAGER); `transfer:approve` approves and rejects (ORG_ADMIN, BRANCH_MANAGER);
  everyone who can read inventory can view transfers. Users are not tied to a single store, so "who may dispatch or
  receive at a given store" is not restricted yet.
  *Dispatch screen* (`POST /api/transfers/:id/dispatch`, permission `transfer:dispatch`; opened from the row's truck
  button or the transfer's "Dispatch stock"): for an **approved** (or partially dispatched) transfer it shows the transfer
  reference, source and destination branch and, per line, the medicine, batch, **approved quantity**, quantity already
  sent, stock available now, the **dispatch quantity** to send and the **remaining quantity** that will be left. A line can
  be sent in part (the transfer becomes *partially dispatched* until every line is out) and the rest dispatched later, or
  the transfer can be **closed short** ("this is everything I can send": the unsent remainder is dropped and only what was
  dispatched is received). The server refuses to dispatch more than approved-and-unsent, or more than the batch really has
  free (on hand **minus reserved**), expired, quarantined or recalled stock. One MongoDB transaction does all of it or
  nothing: guarded stock decrements, a `TRANSFER_OUT` ledger entry per batch, a **permanent Dispatch record** with a
  unique reference (`DSP-0001` … per organization), the dispatch date and the dispatching user, the transfer's new state
  and the audit entry; a failed attempt leaves no stock, ledger, record or reference number behind. Dispatch records can't
  be updated or deleted (the model refuses it, like the stock ledger). **Duplicate submissions** are prevented twice: the
  screen sends an idempotency key (a double click or a retry returns the original dispatch with `duplicate: true`), and a
  version counter on the transfer makes two different dispatches racing for the same transfer or the same stock lose
  cleanly. Cancelling after a partial dispatch returns only what was sent.
  *Receiving screen* (`POST /api/transfers/:id/receive`, permission `transfer:receive`; row "Receive" button or the
  transfer's "Receive stock" / "Receive the rest"): shows Transfer Reference, Source and Destination Branch, Dispatch Date,
  and per line Medicine, Batch Number, Dispatched, Previously Received, Remaining and Current Received Quantity (plus
  Damaged and Missing/Short). Received can never exceed dispatched minus what is already accounted for; a **partial
  receipt** leaves the rest expected (status `partially_received`) and can be completed later, or closed with an
  explanation ("closeReceipt"). **Damaged or missing units require remarks.** Nothing is credited to the destination until the
  receipt is confirmed, and then only the good units; damaged/missing units credit no batch. Each receipt is one
  transaction that writes the stock credit, `TRANSFER_IN` ledger entries, an immutable **Receipt record** (`RCV-0001` …,
  receiver and timestamp), the new status (`completed` automatically once everything is accounted for) and the audit entry;
  an idempotency key and a version counter protect against double submits and races. Units in transit = dispatched − received − damaged − missing.
  *Audit trail:* every step writes an immutable `TransferEvent` (action, previous/new status, user, branch, remarks,
  timestamp, metadata), shown in the transfer's "Audit trail" and at `GET /api/transfers/:id/events`. The `Transfer` model
  is the spec's StockTransfer (requested/approved quantity = `quantity`, plus `expectedArrivalDate`, `internalRemarks`,
  rejection/cancellation reasons).
  *Permissions (all enforced by the API):* `transfer:view`, `create`, `edit` (edit/delete a draft), `submit`, `approve`, `reject`,
  `dispatch`, `receive`, `cancel`, `print`. For existing setups `transfer:manage` still covers create/edit/submit/cancel,
  `transfer:approve` covers reject, and `inventory:read` covers view and print. *Stores:* a user's `branchIds` (empty = every
  store; org admins always see every store) limit them to transfers involving those stores — others are "not found";
  drafting/editing/submitting/dispatching needs the **source** store and receiving the **destination** store. *Self-approval:*
  nobody except an org admin can approve a transfer they created or submitted, unless the organization turns on
  `allowSelfApproval` (`PUT /api/transfers/settings`). Another organization's transfers are always 404. `GET /api/transfers/:id`
  also returns `access` (what this user may do with it) which the screen uses to show only working buttons.
  `GET /api/transfers/:id/history` (same as `/events`) and `/print` (document data) complete the endpoint set.
  *Notifications:* the bell shows transfer updates (submitted for approval, approved, rejected, dispatched, partial receipt,
  received/completed) from `GET /api/transfers/notifications` — derived from the permanent event history of the last 14 days,
  limited to the user's stores, "submitted" only for approvers; "New" is remembered per person in the browser.
  *Transfer note:* the print preview (from `GET /api/transfers/:id/print`) has the logo and organization details, both stores, lines
  with batch, expiry, quantity (and received/damaged once receiving), remarks, and dispatch/receiving signature blocks;
  use Print, and "Save as PDF" in the print dialog for a PDF (there is no separate PDF generator in the project), or download CSV.
  *Scope:* the Selling Point, invoices and CSV import work on the **default store**; the inventory totals, alerts and
  dashboard count stock across all stores (units in transit are counted nowhere until received). Choosing a store at the
  Selling Point and per-store dashboards are the natural next step. Existing databases: `npm run migrate` assigns every
  existing batch to the default store, rebuilds the batch indexes, and renames older "pending" transfers to "in transit" and records full dispatch quantities on older transfers (idempotent).
- **Sales Returns** (`/sales-returns`, API `/api/sales-returns`): customers bringing medicines back against an invoice. Page: four cards
  (Total Refunded, Returns Processed, Items Restocked, Pending Refunds), search (return, invoice, customer, phone, medicine), reason and
  status filters, a table, paging, and a **Process New Return** form. *Form:* find the completed invoice (`GET /invoices?search=`), choose
  products (returnable = bought − already returned, enforced atomically on the invoice line), reason (7), condition and restocking, refund
  (method, amount, status, reference, remarks). Amounts come from what the customer actually paid (bill discount included, split so a full
  return equals the invoice total exactly); refunds can never exceed what was paid. *Restocking is never automatic:* only good units, for a
  reason other than Expired/Damaged, into an active unexpired batch, with an "I inspected them" tick, go back into the **original batch**
  (same batch number and expiry) with a `SALE_RETURN` ledger entry. *Workflow:* people with `returns:approve` (org admin, branch manager)
  record returns directly; others (e.g. billing staff) record them as **pending** - units are claimed but nothing is restocked and no refund
  can start until approval (approving adds only the already-verified units, or none with "don't restock"). Reject (reason required) releases
  units and refund back to the invoice, and is refused once units were restocked or the refund paid. `returns:refund` (admin, manager,
  billing staff) records refund steps (pending/processing/completed/failed); **completed is final**, so a refund can't be paid twice; no
  payment is ever started. Every step is in the return's history, the activity log and (stock) the ledger. Endpoints: `GET /`, `/meta`,
  `/summary`, `/:id`, `/invoices`, `/invoices/:id`; `POST /`, `/:id/approve`, `/:id/reject`, `/:id/refund`; `PATCH /:id` (notes, refund
  method/remarks). The invoice itself never changes except for `returnedQuantity` per line and `returnedAmount` / `refundedAmount` beside its
  total; the dashboard shows refunds and net revenue next to revenue. *Limitations:* the dashboard's revenue still counts the original
  invoice total; refunds on credit sales don't reduce the customer's due; customers live on invoices (there is no customer module).
- **Orders** (`/orders`, API `/api/orders`, suppliers `/api/suppliers`): orders placed with suppliers for stock that is expected to arrive.
  *Page:* search (order id, supplier, product, supplier reference), a table (#, Order ID, Supplier, Date, Items, Status, Actions), paging
  (10/25/50), **Add Order**, **AI Billing**, row actions View / Receive / Cancel, and a details view with the products (ordered, free, received,
  accepted, rejected/damaged, pending, rate, discount, GST), totals, payment, who created/approved it, the goods received history and the order's history;
  from the details: Edit (drafts), Submit, Approve / Send back, Mark as ordered, Receive items, Cancel, **Print Order** and **Download PDF** (the print
  window's "Save as PDF", titled with the order number; there is no separate PDF generator). The dashboard has a "Supplier orders" panel.
  *Suppliers:* the project had no Suppliers module (the menu item is still "coming soon"), so a minimal `Supplier` collection (name, contact person,
  phone, email, address, GST number) with list / get / add was added; orders keep a snapshot of the supplier's details. What each supplier is owed is
  worked out from their orders (unpaid balances of orders that are not drafts or cancelled) and shown beside them: there is no credit module yet.
  *Add Order:* supplier (details shown), store, dates, reference, notes; products searched from inventory (stock, unit, GST, last purchase price,
  batches); per line quantity, free quantity, rate, discount %, GST %; shipping / packaging / other charges, additional discount, GST on charges; payment
  terms, method, advance (status and remaining are worked out; payment is only RECORDED, nothing is paid). All arithmetic is in whole paise; the server
  recalculates and checks everything. *Workflow:* draft -> submit -> pending (when `PUT /api/orders/settings` turns approval on) or approved -> ordered ->
  partially received -> received; cancel before anything arrives; approving needs `orders:approve` (org admin, branch manager). *Goods Received* (`POST
  /api/orders/:id/receive`): per product the paid and free units arriving, rejected and damaged units (kept separately, with a reason), batch number,
  manufacturing and expiry dates, purchase price (and MRP / selling price for a new batch). Only verified, accepted units go into stock, in their batch
  (an existing batch number tops it up and keeps its one expiry date; otherwise a batch is created) in the order's store, with a `PURCHASE` ledger entry linked
  to the permanent goods received record (`GRN-0001`, immutable). Expired or invalid stock is refused; never more than ordered; a partial delivery leaves the
  rest expected; one transaction; the same idempotency key adds stock once; drafts, pending, approved and cancelled orders cannot be received. Users limited
  to stores (`branchIds`) only see and act on orders for those stores. *Endpoints:* `GET /`, `/summary`, `/meta`, `/products`, `/receipts`, `/settings`,
  `/:id`, `/:id/receivable`, `/:id/print`; `POST /`, `/:id/submit|approve|reject|order|cancel|receive`; `PUT /:id` (drafts), `DELETE /:id` (drafts),
  `PATCH /:id/status`, `PUT /settings`. *AI Billing* has its own page (`/orders/ai-billing`, API `/api/ai-billing`) and is described in its own section below.
- **Import Inventory** (`/inventory/import`, API `/api/import/inventory`): bulk-load medicines and batches from a CSV.
  *Template:* `GET …/template` (one row = one batch; repeat the medicine to add more batches; a row with no batch
  columns just creates the medicine). *Preview:* `POST …/preview?fileName=` with the CSV as the `text/csv` body — the
  server checks type (.csv), size (≤ 2 MB) and row count (≤ 2,000), validates **every row** (mandatory fields, GST
  0–100, HSN, real dates, expiry in the future, selling price ≤ MRP, quantity) and finds duplicate SKUs / barcodes /
  batches inside the file and against this organization's inventory. Nothing is written; the result is stored as an
  `ImportJob`. *Confirm:* `POST …/:id/confirm` takes no data — the server re-validates its stored copy against the data
  as it is now, claims the job atomically (it can be confirmed only once, even with two simultaneous clicks), and imports
  only valid rows (`skipInvalid` is required when some are invalid).
  **Transaction strategy:** one MongoDB transaction per *medicine* (the medicine if new + all its batches + their opening
  ledger entries + the audit entry). A medicine that fails rolls back alone and is reported; the others still import.
  Every row ends as `imported`, `skipped` (medicine or batch already exists — re-importing a file creates no duplicates),
  `invalid` (never attempted) or `failed` (rolled back), so imported + skipped + failed + invalid always equals total.
  Existing medicines (matched by SKU, barcode, or name + strength + form + manufacturer) are never changed. History:
  `GET …/history` and `GET …/:id` show each import with a summary and the result of every row; the job also stores a
  file checksum to warn when the same file is uploaded again. Everything is scoped to the organization.
- **All Compound** (`/inventory/compounds`, API `/api/compounds`): add, edit, search (name or composition), filter by
  status. Each row shows how many medicines use the compound. Medicines are linked from the page
  (`POST /api/compounds/:id/medicines`, `DELETE …/medicines/:medicineId`) or from the medicine form's "Salt / compound"
  field; a medicine has one compound. An **unused** compound can be deleted; one with linked medicines is **archived**
  (status `inactive`) instead — the delete is refused with `IN_USE` — and archived compounds can't take new links.
- **Attributes** (`/inventory/attributes`, API `/api/attributes`): per-organization, fully configurable. Types:
  category, dosage form, strength, unit (lists of allowed values that feed the medicine form's dropdowns) and
  **custom attributes** — extra fields a medicine can carry, e.g. "Storage condition". A custom attribute with allowed
  values only accepts those values (checked on the server when a medicine is saved); with none it accepts any text.
  Attributes can be enabled/disabled (a disabled one isn't offered or enforced; existing values are kept), renamed
  (renaming a custom attribute renames it on every medicine that carries it) and deleted when unused. The type is
  fixed after creation. A category or custom attribute that medicines use can only be disabled, not deleted.
- **Inventory Batch page** (`/inventory/batches`, API `/api/batches`): every batch across medicines in one table
  (medicine, batch number, manufacturer, mfg / expiry date, purchase / selling price, MRP, available quantity, status).
  Search by medicine or batch number; filter by expiry (30 / 60 / 90 days, expired, not expired), manufacturer and
  status; sort and page on the server; filters live in the URL. `GET /api/batches/summary` feeds the four expiry-alert
  cards (cumulative windows, counting only batches that still have stock). Status is calculated, never stored:
  `archived`, `quarantined`, `recalled`, `out_of_stock`, `expired`, `low_stock` (sellable units below the medicine's
  reorder level), else `in_stock`. `POST /api/batches` receives a batch (it must not already be expired; selling price
  ≤ MRP; one batch number per medicine); `PATCH /api/batches/:id` edits only prices, manufacturer, status and reserved
  quantity — batch number, expiry, initial quantity and on-hand stock are fixed (quantity changes are stock
  adjustments), and there is no delete. `GET /api/batches/:id/movements` is the batch's permanent movement history
  (received / sold with invoice number / adjusted / written off, running balance, who did it).
  **Expired batches are never sold**: invoices allocate only from `sellableBatchFilter` batches (active and not past
  expiry), so the Selling Point skips them even when they would expire first.
- **Add / Edit medicine form** (Basic, Commercial and Additional information). It holds product data only; prices
  and quantities live on batches. Validation runs twice: instantly in the browser (`client/src/utils/medicineValidation.js`,
  unit-tested with `npm test` in `client`) and again on the server (`validators/medicine.validator.js`). SKU and barcode
  are unique per organization, **case-insensitively** (partial unique indexes with a collation; blank values are
  ignored). `GET /api/inventory/duplicates?sku=&barcode=&excludeId=` powers the on-blur check, and a clash on save is a
  `409` whose `details` name the field. Searchable fields offer existing values and create new ones on save. Closing
  the form with unsaved changes asks for confirmation.
- `npm run migrate` converts older data (renames fields, builds categories/compounds, backfills ledger balances).

## AI Billing (supplier invoices)

> **Not connected yet?** The page says so and the manual path keeps working. A full walk-through — creating the Google Cloud project, the Document AI
> processor, the service-account key and the Gemini key, with the exact `.env` lines, what it costs and what each error message means — is in
> [docs/invoice-reading-setup.md](docs/invoice-reading-setup.md).

`Orders -> AI Billing`: upload a supplier invoice (PDF / JPG / JPEG / PNG, up to 10 MB), have it read, check the result and save a **draft order**.
Uploading and reading never create orders, match products, receive goods, change stock or record payments: only a person's "Save as Draft" creates a
draft order (the usual order rules apply), and stock only changes when goods are received against an order.

**Phase 1 (upload and review).** Drag-and-drop / Browse Files, file name and size, preview, Remove File, **Scan Invoice**, progress, an editable review
(supplier, invoice, medicine table with batch / dates / MRP, totals), Save as Draft, Cancel. The file is checked by its real contents (not just the
extension), stored under `UPLOAD_DIR` (default `server/uploads`, never served directly, only through an authenticated endpoint) and recorded with a unique
upload id (`UP-…`). Records: `InvoiceUpload`. Products are matched only when they match exactly; near matches are suggestions.

**Phase 2 (OCR with Google Cloud Document AI).** **Scan Invoice** sends the stored file to Document AI from the server and stores what comes back, raw and
**unverified**: the full text, page-wise results (page numbers, lines with confidence and position), tables (rows, columns, cells, page), and — where the
processor detects them — fields (supplier name / GSTIN / phone, invoice number / date / due date / PO number, totals) and line items. A field the
provider did not find is `null` ("Not found"); nothing is invented, guessed or turned into a confirmed value. Quality, rotation and low-confidence warnings
are kept. The **OCR Results** section shows the invoice text, tables, pages and detected fields beside the untouched original, with Reprocess and
Continue to review. Phase 3 (structured extraction and product matching) will read from this stored raw result.

### Scan states and workflow

`Uploaded -> Processing -> Completed | Failed` (a saved draft counts as Completed; removed uploads show "Removed").

1. Validate the file (type by content, size, not empty) at upload — an unsupported file is never stored and never sent to the provider.
2. `POST /extract` claims the upload atomically (`uploaded|failed -> processing`); a second request while it runs gets `409` and the provider is called once.
3. In the background the server reads the stored file, signs in to Google (service-account key, short-lived token cached until it expires), calls the
   processor's `:process` method and normalizes the answer.
4. The result is saved in `InvoiceOcr` (one per upload; reprocessing replaces it), a summary and any warnings go on the upload, the status becomes
   `completed` — or `failed` with the reason (provider errors are mapped to plain messages; the file is kept so it can be retried).
5. The screen follows the status (no page reload) and then fetches `GET /ocr`. A run that never finishes (server restart) is reported as failed after 10 minutes.

### Endpoints (`/api/ai-billing`, need `inventory:write`, scoped to the organization)

| Method and path | What it does |
| --- | --- |
| `GET /status` | is a reading service ready (`configured`, `ocr: {configured, provider, label, missing[], setup}`); never any credential |
| `POST /uploads?fileName=` | upload (body = the file); `GET /uploads`, `GET /uploads/:id`, `GET /uploads/:id/file`, `DELETE /uploads/:id` |
| `POST /:id/extract` | start reading (`202`, status `processing`); `409` if already processing / already read; `501` if no service is connected |
| `GET /:id/status` | `{status, statusLabel, attempts, error, notes, hasOcr, ocr}` (`:id` is the record id or the `UP-…` upload id) |
| `GET /:id/ocr` | the stored OCR result (`409` until there is one) |
| `POST /:id/reprocess` | read a completed or failed upload again, replacing the earlier result (`202`) |
| `POST /uploads/:id/draft` | save the reviewed invoice as a draft order |

Starting a scan is rate-limited per person (`OCR_RATE_LIMIT`, default 30 per 10 minutes → `429`).

### Database

- `InvoiceUpload` (existing, extended): upload id, file name, MIME type, size, SHA-256, storage key, `status` (`uploaded|processing|completed|failed|drafted|discarded`),
  `provider`, `attempts`, `startedAt` / `finishedAt`, `error {code, message}`, `ocrSummary` (provider, page / table / warning counts, duration, time), `notes`,
  `uploadedBy`, timestamps. The structured review draft (`extraction`) is only filled when a structured service is connected.
- `InvoiceOcr` (new, one per upload): `provider`, `processor`, `mimeType`, `pageCount`, `text`, `pages[]`, `tables[]`, `entities[]`, `fields{}`, `lineItems[]`,
  `warnings[]`, `durationMs`, `processedAt`, `processedBy`. Kept in its own collection so the (large) result never bloats upload lists; if a result would
  exceed the 16 MB document limit the line geometry is dropped first (never the text) and `reduced` says so.

### Setting up Google Document AI

1. In the [Google Cloud console](https://console.cloud.google.com/) pick or create a project and make sure billing is enabled.
2. **Enable the API:** *APIs & Services -> Library -> "Cloud Document AI API" -> Enable* (or `gcloud services enable documentai.googleapis.com`).
3. **Create a processor:** *Document AI -> Processor gallery* -> **Document OCR** (text, layout, tables) or **Invoice Parser** (adds detected invoice fields and
   line items). Choose a region (`us` or `eu`). Copy the processor **ID** from its details page.
4. **Create a service account:** *IAM & Admin -> Service accounts -> Create*; grant it the role **Document AI API User** (`roles/documentai.apiUser`).
   *Keys -> Add key -> JSON* downloads the key file. Store it **outside the repository** (or in a git-ignored folder) — never commit it.
5. Set these in `server/.env` (or the host's environment) and restart the server:

   | Variable | Meaning |
   | --- | --- |
   | `GOOGLE_CLOUD_PROJECT_ID` | the project id |
   | `GOOGLE_DOCUMENT_AI_LOCATION` | the processor's region, e.g. `us` |
   | `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` | the processor id |
   | `GOOGLE_APPLICATION_CREDENTIALS` | absolute path to the service-account JSON key |
   | `OCR_PROVIDER` | optional, default `google-document-ai` |
   | `GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION` | optional: pin a processor version |
   | `GOOGLE_DOCUMENT_AI_IMAGE_QUALITY` | optional `true`: ask for blur / quality scores (processors that support them) |
   | `OCR_TIMEOUT_MS` | optional, default 120000 |
   | `OCR_RATE_LIMIT` | optional, scans per person per 10 minutes (default 30) |

The credentials stay on the server: the browser only ever sees whether a service is configured and the *names* of missing settings. Until all four required
variables are set, the page says so and offers the manual review. Google's online-processing limits apply (about 15 pages and 20 MB per document for most
processors).

### Testing

`cd server && npm test` (the OCR tests use a fake Google: they check the request path and body, the signed sign-in and token reuse, single / multi-page,
JPG / PNG, blur and rotation warnings, tables, detected fields, that unsupported files are never sent, every failure mode — 400 / 401 / 403 / 404 / 429 / 5xx,
bad JSON, empty text, timeout, unreachable — retry, reprocess, duplicate and concurrent scans, permissions, organization isolation, the rate limit and that no
order, goods receipt or stock is touched). `cd client && npm test` covers the OCR view helpers; `cd e2e && node all.mjs` drives the page in a browser.
Against the real service: set the variables, upload a sample invoice and press Scan Invoice; the result should match the document.

### AI invoice extraction (Phase 3)

After OCR completes, **Extract Invoice with AI** sends the OCR *text and tables* (never the file) to a language model and turns them into a structured
invoice: supplier, invoice details, one entry per medicine row (batch, expiry, quantity, free quantity, MRP, purchase rate, discount, GST, line total…) and
the invoice totals. The result is **never trusted and never verified by the AI**: it is checked strictly, re-calculated by the backend, linked back to the OCR
text, and shown in an editable form for a person to review. Nothing is matched to products, ordered, received, paid or added to stock.

**Pipeline.** `POST /ai-extract` claims the upload atomically (`aiStatus: processing`), then in the background: OCR record -> prompt (page text + tables row by
row) -> model with a JSON response schema (temperature 0) -> `normalizeExtraction` (unknown keys dropped, every value coerced to its type or `null`, anything
dropped reported with its original) -> `buildMeta` (source tracking) -> `validateExtraction` (money) -> duplicate check -> saved as a new `InvoiceExtraction`
version. Failures keep the OCR untouched and can be retried.

**Rules the model is given** (and which the checks enforce afterwards): use only the OCR; missing = `null`; never invent batch numbers, expiry dates, rates
or GSTINs; one item per row, never merged; MRP is not the purchase rate; free quantity is not added to quantity; received quantity only if explicitly shown;
line figures belong to the item, invoice-level charges to the totals.

**Confidence and sources.** The model is *not* asked how sure it is. Each value is looked for in the OCR: found in a table cell or line -> the OCR provider's own
confidence for it (high >= 90%, medium >= 70%, low < 70%; no confidence given -> medium with `confidence: null`), page and OCR snippet kept; not found in the OCR
text -> low and flagged (`NOT_IN_OCR`, typical of an invented value); `null` -> missing; typed by a person -> edited. Row text quoted by the model is matched to
an OCR table row so a row can be traced to its page.

**Validation** (`services/aiExtraction/invoiceValidationService.js`, pure, money in whole paise, nothing is ever corrected — differences are shown with both
numbers): supplier name; GSTIN format and state code; invoice number and date (real calendar day, not in the future); due date; quantity, rate, MRP numeric
and non-negative; rate above MRP; discount within limits and consistent (percent vs amount); standard GST rates; HSN format; batch and expiry present, expiry
after manufacturing and not already passed; per line: quantity x rate - discount = taxable, taxable x GST = tax, taxable + tax = total (a pre-tax line amount
is accepted); totals: taxable, CGST, SGST, IGST and subtotal against the lines, grand total against taxable + taxes + charges + round off (either from the totals
or from the line totals), balance due. Severity `error` / `warning` / `info`; a path on each issue lets the screen outline the field.

**Duplicates.** The same supplier (GSTIN, or name) and invoice number among existing orders (not cancelled) and among other uploads' current readings is
reported on the invoice, and **Save as Draft is refused (409 `DUPLICATE_INVOICE`)** while such an order exists. Only someone with `orders:approve` can confirm a
legitimate case (`acknowledgeDuplicate`, audited).

**Statuses.** OCR Pending, OCR Completed, AI Processing, AI Extraction Completed, Validation Required, Ready for Review, Reviewed, Failed. *Reviewed* is set only
when a person confirms they checked the invoice (errors must be acknowledged); any later edit removes it.

**Versions.** Every run adds an `InvoiceExtraction` version; `data` (the AI's answer) is never edited, `current` is the working copy people correct, and older
versions stay readable (`GET /extracted?version=1`). An extraction made before the OCR was read again is reported as `stale`.

#### AI endpoints (`/api/ai-billing`, `inventory:write`)

| Method and path | What it does |
| --- | --- |
| `POST /:id/ai-extract` | start (`202`); `409` if OCR is not done / already running / already extracted; `501` if no AI provider is set up |
| `POST /:id/reprocess-ai` | extract again as a new version (`202`) |
| `GET /:id/extraction-status` | `{state, stateLabel, aiStatus, version, error, validation, duplicateCount, stale, humanReviewed}` |
| `GET /:id/extracted[?version=n]` | `{original, current, meta, validation, issueMap, duplicates, aiWarnings, versions, state…}` |
| `PUT /:id/extracted` | corrections `{data, reviewed?, confirmed?, acknowledgeIssues?, expectedEditCount?}`; wrongly typed values are refused (`422`) |
| `POST /:id/validate` | run the backend checks again (never changes the data) |

#### Configuration

| Variable | Meaning |
| --- | --- |
| `AI_EXTRACTION_PROVIDER` | `gemini` or `openai` (default: Gemini if `GEMINI_API_KEY` is set, else OpenAI if `OPENAI_API_KEY` is set) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Google Gemini key (sent in a header, never in a URL) and model (default `gemini-2.5-flash`) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI key and model (default `gpt-4.1-mini`); structured outputs with a strict JSON schema |
| `GEMINI_ENDPOINT`, `OPENAI_ENDPOINT` | optional address overrides (tests, proxies) |
| `AI_EXTRACTION_TIMEOUT_MS` | optional, default 120000 |

Keys stay on the server; the browser only learns whether a provider is configured. Model names are defaults you can change; check them against the provider's current list.

#### Database

New collection `InvoiceExtraction` (one document per version: `provider`, `model`, `usage`, `ocrId` / `ocrProcessedAt`, `data`, `problems`, `aiWarnings`, `current`,
`meta`, `validation`, `duplicates`, `reviewStatus`, reviewer / editor / initiator, `editCount`, `extractedAt`). `InvoiceUpload` gains `aiStatus`, `aiVersion`,
`aiAttempts`, `aiStartedAt`, `aiFinishedAt`, `aiError`. The OCR record is read, never changed. Removing an upload removes its extractions.

### Product matching (Phase 4)

**Match Products** compares every medicine of the AI-extracted invoice with the **existing products** (the `Medicine` collection — no second product store),
shows up to five suggestions per row with the reasons and conflicts, and lets a person confirm, change or reject each one. It never creates or changes a
product, never touches stock, batches or orders, and never confirms anything on its own.

**How a row is compared** (`services/productMatching/`): `productNormalizationService` describes a medicine in comparable parts — a plain name (abbreviations such
as PCM -> paracetamol expanded from a small explicit dictionary, strengths / forms / pack sizes removed), strengths (`500 MG`, `0.5 g` -> `500mg`, `250mg/5ml`),
dosage form (`tab`, `caps`, `syp`, `inj`… -> tablet, capsule, syrup, injection…), pack size (`10s`, `strip of 15`, `1x10`; a singular `500 TAB` is a strength, not a
pack) and the active ingredients it names. `productSimilarityService` compares two descriptions attribute by attribute:

| Attribute | Agreement | Disagreement |
| --- | --- | --- |
| Strength | reason | **critical conflict** (500 mg is not 650 mg; a bare number such as `PCM 500` is compared by value) |
| Dosage form | reason | **critical conflict** (tablet / capsule / syrup / injection are never interchangeable) |
| Active ingredient | reason | **critical conflict** (when both sides name one) |
| Manufacturer | reason (legal suffixes ignored) | warning |
| Pack size | reason | warning (shown, never decisive) |
| HSN (first 4 digits), brand | reason | warning |
| SKU / barcode appearing on the line | strong reason | — |
| Something the product states and the invoice leaves out | — | warning ("strength not stated") |

The **score** is a weighted similarity of the attributes both sides state (name 0.50, strength 0.20, dosage form 0.15, manufacturer 0.10, pack 0.03, HSN 0.02;
missing attributes are not scored). It is **not a probability**. Names are compared word by word with spelling tolerance (edit distance) and as whole strings
(character pairs).

**Decision per row:** *Matched* = best candidate with no conflict and no warning, score >= the auto threshold, and no equally good rival; *Needs review* = a plausible
candidate with a warning, a middling score, or a rival of equal standing; *Unmatched* = nothing at or above the review threshold without a critical conflict. A
critical conflict **never** produces *Matched*, whatever the score; the conflicting products are still shown as suggestions (marked "Conflict") so a person can see
what is closest, and choosing one needs an explicit acknowledgement. A row with no name is unmatched; a row that states neither strength nor form is flagged.

**Thresholds** (environment, read on every call): `PRODUCT_MATCH_AUTO_THRESHOLD` (0.90), `PRODUCT_MATCH_REVIEW_THRESHOLD` (0.55, never above the auto one),
`PRODUCT_MATCH_SUGGESTION_FLOOR` (0.35), `PRODUCT_MATCH_MAX_SUGGESTIONS` (5, at most 10), `PRODUCT_MATCH_AMBIGUITY_MARGIN` (0.04). The thresholds in use are returned with
the results.

**Confirmation.** A match is a suggestion until a person confirms it (`confirmation`: pending / confirmed / unmatched). *Confirm all eligible* confirms only rows that are
*Matched*, or *Needs review* rows a person has already chosen a product for — never a bare suggestion, never a row with a conflict, never an edited (stale) row.

**Remembered mappings** (`ProductMapping`): when a person confirms, the supplier's description is remembered (original name, normalized key, supplier id or GSTIN / name,
product id, manufacturer, strength, dosage form, pack size, source automatic / manual, who and when). Next time the **same supplier** sends the **same normalized
description** the mapping is reused ("Previously confirmed") — but the product is compared with the line again first, so a product whose strength or form has since
changed is not matched silently. A mapping is written only for a manual choice or a clean "Matched" row (never from similarity alone) and there is one per supplier
description (a different product replaces it; the old one is kept in its history; concurrent confirmations make one).

**Storage.** Per extraction version, `InvoiceExtraction.matching.items[]` holds for every row (keyed by the row's stable `itemId`): `extractedMedicineName`,
`normalizedMedicineName`, `existingProductId`, `matchingStatus`, `confirmation`, `matchingScore`, `matchingReasons`, `matchingWarnings`, `conflicts`,
`suggestedProductIds` (+ the scored suggestions), `mappingSource` (automatic / manual / previously_confirmed), `confirmedBy`, `confirmedAt`, and a history of what
happened. Product ids only: product details are read from the product master when shown. A row edited after it was matched is flagged stale and must be matched again.
Each row keeps its own batch, expiry, quantities and prices from the invoice.

#### Product matching endpoints (`/api/ai-billing`, `inventory:write`)

| Method and path | What it does |
| --- | --- |
| `POST /:id/match-products` | match the rows `{rematch: 'open' \| 'all', force?}` (confirmed / chosen rows are kept unless `all` + `force`) |
| `GET /:id/product-matches[?status=&search=]` | the rows, the summary for the four cards, thresholds, `complete` / `readyForPhase5` |
| `GET /:id/product-matches/:itemId/suggestions[?search=]` | the best five, or a manual search of the products (name, SKU, barcode, manufacturer, brand, strength) |
| `PUT /:id/product-matches/:itemId` | choose / change the product `{productId, acknowledgeConflicts?}` (critical conflicts -> 409 `MATCH_CONFLICT` unless acknowledged) |
| `POST /:id/product-matches/:itemId/confirm` | confirm the row's product (writes the mapping) |
| `POST /:id/product-matches/confirm-all` | confirm every eligible row |
| `POST /:id/product-matches/:itemId/mark-unmatched` | decide that no existing product fits (a new product is added in Inventory, never here) |
| `GET /:id/verified-lines` | the product-linked lines for the next phase: original description, confirmed product id, batch, expiry, manufacturing date, quantity, free quantity, rate, MRP, discount, GST, line total, confirmation status |

**Limits:** products are compared in memory (up to 50,000 active products); the product category and an invoice-side brand are only compared when present; the abbreviation and ingredient lists
are small and explicit (`productNormalizationService.js`) — extend them for your catalog; a brand name the system has never seen (for example *Crocin* for paracetamol) is only matched by
a remembered mapping or by a person.

### Purchasing and goods receipt (Phase 5)

After the products are confirmed, **Proceed to Goods Receipt** takes a verified supplier invoice through the **existing** Orders, Suppliers, Products, Batches and
Stock modules. There is no second inventory and no second order system: an order is the purchase record, the `GoodsReceipt` (GRN) is the permanent receipt, and the
only code that adds stock is `order.service.receiveOrder` (one transaction), which this phase extends rather than replaces.

**Workflow.** (1) *Final invoice review*: supplier, invoice, every medicine with its confirmed product / batch / expiry / quantities / rates / MRP / discount / GST /
line total, and the financial summary, with the checks that must pass — OCR and AI done, the extraction reviewed by a person, invoice number and date present, supplier
chosen from your suppliers, **no unresolved validation errors**, **every medicine matched to a confirmed product**, not a duplicate of a recorded supplier invoice, and
permission to receive goods (batch/expiry gaps and figure warnings are listed but not blocking). The person ticks the verification box and confirms; any later change to
the invoice or its matches makes that verification stale. (2) *Purchase order*: **create** one from the invoice (supplier, branch, invoice number as the reference,
products, quantities, free quantities, rates, discounts, GST, shipping / packaging / other charges) as a draft or taken on to "ordered" through the normal workflow and
permissions, or **link** an existing order of the same supplier (search by order id, supplier, supplier invoice number, PO number) after seeing, per product, ordered /
previously received / invoice quantity / remaining / difference. Linking never changes the order; differences must be acknowledged; a product the order does not contain
blocks linking. (3) *Goods receipt*: a draft with the invoice figures beside empty fields for what **actually arrived** (paid and free), rejected, damaged, batch,
manufacturing and expiry dates, MRP, selling price and remarks. **Accepted = arrived − rejected − damaged.** (4) *Confirm Goods Receipt & Update Stock* after a summary.

**Inventory rules** (enforced by the receiving service, not the screen): only accepted units enter sellable stock (invoice 100, arrived 95, rejected 5 → +90); a batch is
created or, when the product and batch number exist (same expiry), topped up — never duplicated; an accepted unit needs a batch number and a future expiry, so **expired,
rejected, damaged or batch-less units are never added**; never more than ordered; cancelled or not-yet-ordered orders cannot be received; one medicine can arrive in
several batches in one receipt and in several receipts over time; free units are tracked separately from paid ones on the order and the GRN. Each accepted unit is a
`PURCHASE` entry in the append-only stock ledger (the spec's `PURCHASE_RECEIPT`) with the batch, branch, user, time, new balance (previous = new − added) and the GRN id.

**Safety.** Confirming runs in one MongoDB transaction: stock, ledger entries, the GRN, the order's received counts and status, the supplier-invoice record and the
draft all commit together or not at all (a failing line rolls back everything). A guarded atomic claim on the order lines stops two receipts taking the same units, and an
idempotency key makes a repeated or simultaneous confirmation return the original GRN (`replayed: true`) — stock rises once. A draft is claimed (`confirming`) first so two
people cannot confirm it at once; if a request dies after the claim a stale claim is released. *Limitation:* transactions need MongoDB as a replica set (as in production
and the tests); on a standalone server the same code runs without atomicity, so use a replica set.

**Reversal** (`orders:approve`): a confirmed receipt is taken back out by **opposite ledger entries** (type `ADJUSTMENT`, reference `GoodsReceiptReversal`) and a permanent
reversal record; the GRN is never edited. Units already sold, moved or reserved cannot be taken back (409 `BATCH_STOCK_USED`) so stock never goes negative; the order's
counts and status (back to *ordered* or *partially received*) and the supplier invoice are recalculated. A receipt can be reversed once.

**Statuses.** Order: draft → pending → approved → ordered → partially received → received (cancelled is final; a cancelled order cannot be received). Updated automatically
from received quantities, across any number of GRNs.

**Purchase history and money.** `SupplierInvoice` records, per supplier, the invoice number (unique when normalized — letters and digits only), date, order, products and
batches, accepted / rejected / damaged quantities as receipts are confirmed, amounts, who created and verified it, and the order's payment status. A repeat of the same
supplier invoice number is refused (409); someone who can approve orders may record a legitimate repeat (kept with a `#2` key and a link to the first). **No payment is made or
marked paid**: the supplier's outstanding balance is the existing figure derived from the orders (an order made from an invoice is "unpaid" until the order records otherwise).

#### Endpoints

| Method and path | Needs | What it does |
| --- | --- | --- |
| `GET /api/ai-billing/:id/final-review` · `POST` | `inventory:write` | the review page's data and checks · the person's verification `{confirmed, supplierId?, acknowledgeDuplicate?}` |
| `GET /api/ai-billing/:id/purchase-order-options[?search=]` | `inventory:write` | orders that could be this invoice's, each with the per-product comparison |
| `POST /api/ai-billing/:id/create-purchase-order` | `inventory:write` | `{branchId?, status: 'draft' \| 'ordered', acknowledgeDuplicate?}`; repeating returns the same order |
| `POST /api/ai-billing/:id/link-purchase-order` | `inventory:write` | `{orderId, acknowledgeDifferences?}`; the order is not changed |
| `POST /api/goods-receipts` | `inventory:write` | a draft from an AI Billing invoice `{uploadId}` or an order `{orderId}` (repeating returns the open draft) |
| `GET /api/goods-receipts[?status=draft\|confirmed\|reversed&search=&orderId=]` · `GET /:id` | `inventory:read` | drafts / confirmed GRNs (with their reversal, supplier invoice and stock entries) |
| `PUT /api/goods-receipts/:id` | `inventory:write` | edit a draft's quantities, batch details, notes (invoice figures never change) |
| `POST /api/goods-receipts/:id/confirm` | `inventory:write` | `{confirmed: true}` — adds the accepted units to stock, once |
| `POST /api/goods-receipts/:id/reverse` | `orders:approve` | `{reason}` — opposite ledger entries; never edits history |
| `GET /api/purchases/:id/history` | `inventory:read` | the order, its supplier invoices, GRNs (and reversals), drafts, the stock entries each made (previous, change, new, rejected, GRN, supplier, order, user, time) and the payment status |

Existing roles and permissions are reused (no new ones); store-limited users only reach orders of their stores.

**Database:** new `GoodsReceiptDraft`, `SupplierInvoice`, `GoodsReceiptReversal`; `GoodsReceipt` gains `supplierInvoice`, `draftId`, `uploadId`; `InvoiceExtraction` gains
`finalReview` and `purchase`. **Tests:** `server/tests/purchase-integration.test.js`.

## Branch Management

`/branches` (menu: **Branch**) manages the organization's branches. They are the same **stores** the transfer, order, batch and goods receipt screens already use (the
`Branch` model and `/api/branches`); nothing was duplicated. The default branch ("Main Store") always exists, is where the Selling Point sells from, and can be neither
deactivated nor deleted.

**Page.** Title *Branches* / "Manage your store branches.", a green **Add Branch** button (for people with `settings:manage`), a search box ("Search by branch name...",
which also finds codes), a status filter, and a table: # · Branch Name (with code) · Address · Status badge · Actions (View, Edit, Activate / Deactivate, Delete). Paging shows
"Showing page 1 of 1 with N total records", rows per page 10 / 25 / 50 / 100, Prev / Next. Empty: **No Branches found** — "Add a new Branch or adjust the filters to see matching records."
Everyone who can read inventory can view; managing needs `settings:manage`.

**Add / Edit.** *Basic Information:* name\*, code\* (unique, letters / numbers / `. _ -`, saved in capitals), phone, email, status. *Address:* line 1\*, line 2, country
(India by default), state, city, PIN code\*, landmark. *Additional:* branch manager, GSTIN, opening date, notes. Formats are checked in the form and again by the server: email,
phone (7 to 15 digits), PIN (6 digits for India; a general postal code elsewhere), GSTIN, a real opening date. A duplicate code or name (any letter case) is refused with a
message under the field. Saving disables the button, so a double click cannot save twice. Editing loads the saved values, validates the same way, updates the record and
refreshes the list. The one-line `address` older screens show is built from the parts. **View** shows every field plus created / last-updated times and an Edit button.

**Compatibility.** The older quick shape (name + code only, as the transfer screen's "Manage stores" dialog sends) is still accepted. As soon as a request carries any profile field
(the Branches page always sends all of them) address line 1 and PIN code become required. A branch made the quick way shows its one-line address, and must be completed when
edited through the Branches page. `GET /api/branches` returns the plain array of every branch unless `page`, `limit`, `search` or `status` is given, in which case it returns
`{ items, page, limit, total, pages }`. `GET /api/branches/:id` returns one branch with its stock, batch and open-transfer counts.

**Status.** Active / Inactive badges; changing status asks for confirmation. An inactive branch is **refused** for new orders, new stock batches, transfers and for receiving
goods (a purchase order placed for a branch that has since been deactivated cannot be received until it is active again); the screens only offer active branches. Nothing
historical is touched: its orders, batches, ledger entries and transfers stay readable. A branch with an open transfer cannot be deactivated.

**Delete.** A branch is deleted only if nothing refers to it. Otherwise the request is refused (409 `IN_USE`) with the reasons — *stock or stock history*, *transfers*,
*purchase orders or goods receipts*, *staff assigned to it* — and "Deactivate it instead". Sales and returns are not tied to a branch (they use the default branch). Nothing related is ever deleted
along with a branch. (This project deletes records that were never used and archives the ones that were, so an unused branch is removed and the deletion is audited rather than soft-deleted.)

**Database:** `Branch` gains optional `email`, `addressLine1`, `addressLine2`, `country`, `state`, `city`, `pincode`, `landmark`, `managerName`, `gstin`, `openingDate`, `notes`.
**Tests:** `server/tests/branches.test.js`, `client/src/utils/branchForm.test.js`, and a browser test.

## Credit Management

`/credit` (menu: **Credit Management**) is where a person asks for credits: they pay an amount, upload a screenshot of the payment, and an administrator later decides how many
credits it is worth. *Before this module the system had no credit balance, credit request or credit ledger* ("Credit" only appeared as a sales payment type, an order payment term and
a refund method), so nothing was duplicated and no existing deduction or billing behaviour was touched. It covers requesting, the history, an administrator's **approve / reject** decision with the credit calculation, and the **credit balance and ledger** the approval
writes.

**Page.** Section label *FINANCE MANAGEMENT*, heading *Credit Management*, tabs *Request Credit*, *History & Logs*, *Credit Ledger* and — for `settings:manage` only —
*Approvals* (the active one is in the brand green, with an underline; the tab is kept in the address, `?tab=history`). The header shows the signed-in person's balance as a chip that links to the ledger.

**Request Credit.** A centered card, *Submit Credit Request*: **Payment Amount (₹)** (required, greater than zero, a plain number with at most two decimals, at most ₹10,00,000;
negative, text, `1e3`, `12.345` are refused) and **Payment Screenshot** (JPG / JPEG / PNG / WEBP, up to 5 MB; shows the file name and a preview, and can be replaced or removed).
**Submit Request** validates both (in the browser and again on the server), uploads the file, creates a **Pending** request for the signed-in person with the time of submission,
shows a success or error message, and clears the form only after the server accepted it. The note under the button is built from the configured rate:
"Note: The current conversion rate is 1 Credit = ₹5. The final approved credits will be calculated by the administrator based on your payment amount."

**Screenshot safety** (the same storage as AI Billing's invoice uploads): the type is decided by the file's real first bytes, not its name or what the browser says (a PDF, GIF, SVG or a
program renamed `.jpg` is refused with 415; an image labelled as another type with 400); size is limited by `CREDIT_SCREENSHOT_MAX_MB` (413). The name on disk is made by the server
(`<organizationId>/credit/<new id>.<ext>`) and never from what the user typed; every path is resolved and checked to stay inside the upload folder, so `../` in a name leads nowhere.
Files are written `wx` (never overwriting) with mode `0600`, live outside anything the web server serves, and are read back only through `GET /requests/:id/screenshot` — for the owner
and administrators, with `nosniff`, `no-store` and a sandbox CSP, so nothing can be executed or cached by a proxy. The storage key and the hash never leave the server: the API returns
only the file name, type and size. A refused or failed request leaves no file behind, and the original file name is sanitised before it is stored or shown.

**Duplicates.** The send button is disabled while sending and every form carries an `Idempotency-Key`, so a repeated or simultaneous send is the same request (200 with the first
one). The same payment screenshot (SHA-256) cannot back two live — pending or approved — requests (409 `DUPLICATE_SCREENSHOT`, naming the first); a rejected proof may be sent again.
Submitting is limited per person (`CREDIT_RATE_LIMIT`, default 20 per 10 minutes).

**Conversion rate** — one setting: `Organization.settings.creditRupeesPerCredit` (an administrator changes it with `PUT /api/credits/settings`), else the `CREDIT_RUPEES_PER_CREDIT`
environment default, else 5. Every screen asks `GET /api/credits/settings`; a request stores the rate it was made at and an *estimate* of the credits.

**Credit calculation (server only).** `Approved credits = floor(approved payment amount ÷ rate)`, computed in whole paise so there is no float error: ₹500 = 100, ₹1,000 = 200, ₹2,500 = 500
at ₹5. **Rounding policy: whole credits, rounded down**; the leftover (₹499.50 → 99 credits, ₹4.50 left) is kept on the request as `remainderAmount` and not converted; an approved amount
worth under one credit is refused. The credits come from the amount the **administrator approves** (it starts as the requested amount but may differ), never from anything the browser
sends (credit fields in an approve call are ignored). The request keeps `amount` (requested), `approvedAmount`, `approvedRate` (the rate in force at approval) and `approvedCredits` separately,
so the calculation can always be repeated. Approving or rejecting is atomic (a request is decided once; 409 otherwise), needs `settings:manage`, cannot be done by the requester on their own
request (403), rejection needs remarks, and both are logged.

**History & Logs.** The person's own requests only (newest first; administrators can also show everyone's): #, Request ID, Date, Payment Amount, Approved Amount, Credits, Payment Proof
(View → the screenshot, fetched through the authenticated endpoint), Status badge (Pending amber, Approved green, Rejected red), Admin Remarks and Actions (View details: calculation, log,
and for administrators the review panel with a live credit preview). Filters: search by request ID, status, date range (inclusive); paging 10 / 25 / 50 / 100; a proper empty state.

| Method and path | Needs | What it does |
| --- | --- | --- |
| `GET /api/credits/settings` | signed in | `{ rupeesPerCredit, custom, acceptedTypes, maxFileMB, maxAmount }` |
| `PUT /api/credits/settings` | `settings:manage` | `{ rupeesPerCredit }` — existing requests keep their rate |
| `POST /api/credits/requests?amount=&fileName=` | signed in | the image is the body; `Idempotency-Key` header; 201 (or 200 for a repeat) |
| `GET /api/credits/requests[?search=&status=&from=&to=&page=&limit=&scope=all]` | signed in | own requests; `scope=all` only for `settings:manage` |
| `GET /api/credits/summary[?scope=all]` | signed in | request counts and credits awarded |
| `POST /api/credits/requests/:id/approve` `{ approvedAmount, remarks? }` · `/reject` `{ remarks }` | `settings:manage` | decide a pending request; credits calculated by the server, balance and ledger written in one transaction |
| `GET /api/credits/balance[?userId=]` | signed in | own balance and the entry it last moved on (`userId` only for `settings:manage`) |
| `GET /api/credits/transactions[?scope=all&userId=&type=&search=&from=&to=&page=&limit=]` | signed in | the credit ledger; own entries unless `scope=all` with `settings:manage` |
| `GET /api/credits/notifications` | signed in | own decided requests, for the notification menu |
| `GET /api/credits/requests/:id` · `/screenshot` | owner or `settings:manage` | one request · its screenshot (anyone else: 404) |

**Approvals tab (administrators).** Every request of the organization, pending first: search by **requester** (name or email) or request id, status filter, date range, the payment
proof, and a **Review** button on each pending row. The review panel shows what was requested, takes the **verified payment amount** (prefilled with the requested one) and admin
remarks, previews the credits with the same rounding rule the server applies, and approves or rejects — each behind a confirmation dialog, since neither can be undone (approving names the
amount, the credits and the person; rejecting shows the reason the requester will see). It is the same table component as the history, in `mode="review"` — a request is
only ever rendered in one place. A row that is already decided has no Review button, and nobody can review their own request (the server returns 403 as well).

**What an approval does** — one MongoDB transaction, so it is all-or-nothing: the request goes `pending → approved` (guarded, so two administrators acting at once cannot both
succeed), the **requester's** `User.creditBalance` goes up by the credits, a **`CreditTransaction` ledger entry** is appended, and the audit entry records it. A rejection needs a
reason, adds nothing, writes no ledger entry and keeps the proof and the history. A decided request is never decided again (409) — re-opening one would need a documented reversal
workflow, which does not exist. The requester is told through the existing notification menu (derived from the requests, like the transfer notifications — there is no notification
collection).

**Credit balance and ledger.** The balance lives on the user (`User.creditBalance`) and moves **only** together with a ledger entry, in the same transaction, through one function
(`postCreditTransaction`) — so the balance and the sum of the ledger cannot drift apart. Each entry records the transaction id (`CT-0001`), user, request, type, credits (signed, so a
future deduction is a negative entry), **previous balance**, **new balance**, description, created-at and created-by. The ledger is **append-only**: update and delete are refused by
the model itself, and a unique index on (organization, request, type) means one request can add credits only once. The *Credit Ledger* tab shows the balance and the entries (own, or
everyone's for an administrator) and the header chip re-reads the balance on load, every minute, and the moment an approval happens in that tab.
*Not built:* nothing **spends** credits yet — there was no credit deduction logic in the system to preserve (before this module "Credit" existed only as a sales payment type, an order
payment term and a refund method), so the ledger is ready for debits but nothing issues them.

**Audit trail** — every step is recorded by `services/audit.service.js`, readable at `GET /api/activity` with `audit:read` (ORG_ADMIN and BRANCH_MANAGER; never plain staff). No API
writes to it, and the model now refuses update and delete outright, so an entry cannot be rewritten by anyone.

| Action | Written when | Carries |
| --- | --- | --- |
| `CREDIT_REQUEST_SUBMIT` | a request is submitted | requester, request no, amount, rate, estimate, status `pending` |
| `CREDIT_PROOF_UPLOAD` | the payment proof is stored | file name, real type, size, SHA-256 (never the storage key); kept out of the activity feed so one request shows once |
| `CREDIT_REQUEST_APPROVE` | an administrator approves | administrator, `before`/`after` (status, approved amount, rate, credits, leftover), requested amount, ledger `txnNo`, balance before and after |
| `CREDIT_REQUEST_REJECT` | an administrator rejects | administrator, `before`/`after` status, requested amount, `rejectionReason`, `creditsAwarded: 0` |
| `CREDIT_AWARDED` | credits move, whatever the cause | ledger `txnNo`, type, whose credits, request, signed credits, previous and new balance |
| `CREDIT_RATE_CHANGE` | the conversion rate is changed | the new rate (existing requests keep theirs) |

A credit **adjustment or reversal** is not implemented; when it is, it goes through the same `postCreditTransaction`, so it will append a ledger entry and a `CREDIT_AWARDED` audit
entry (with negative credits) like everything else.

**Field and route names.** The fields of a credit request follow this project's existing vocabulary rather than new names: `requestNo` is the request id people see (`CR-0001`,
with `_id` as the key), `amount` is the requested payment, `rateAtRequest` / `approvedRate` are the conversion rate at request and at approval, and `remarks` holds the
administrator's note — which for a rejection *is* the reason, so the API also returns it as `rejectionReason`, and `createdAt` is returned as `submittedAt` as well. Nothing is stored
twice. Likewise there is no `/api/admin/...` namespace in this system: every module exposes one resource router and gates the administrator's operations by permission
(`/api/orders/:id/approve`, `/api/transfers/:id/approve`, …), so the administrator's credit APIs are `GET /api/credits/requests?scope=all`, `GET /api/credits/requests/:id` and
`POST /api/credits/requests/:id/approve|reject`, each requiring `settings:manage`.

**Configuration:** `CREDIT_RUPEES_PER_CREDIT` (5) — `CREDIT_CONVERSION_RATE` is accepted as the same setting — `CREDIT_SCREENSHOT_MAX_MB` (5), also accepted as
`MAX_PAYMENT_SCREENSHOT_SIZE_MB`, `CREDIT_MAX_AMOUNT` (1,000,000), `CREDIT_RATE_LIMIT` (20); uploads use `UPLOAD_DIR`. Where both names of a setting are present the project's own
name wins, and an empty value falls back to the default. An organization's own rate in `settings.creditRupeesPerCredit` still beats any of them. Nothing secret reaches the browser:
the client only ever reads `GET /api/credits/settings` (rate, accepted types, size and amount limits) and never a storage path or credential.
**Database:** new `CreditRequest` (request number `CR-0001`, user, amount, rate at request, estimate, screenshot details + hash, status, approval fields, log); new append-only
`CreditTransaction` (`CT-0001`, user, request, type, signed credits, previous/new balance, description, created by); `User.creditBalance`; `Organization.settings.creditRupeesPerCredit`.
**Tests:** `server/tests/credit.test.js`, `credit-review.test.js`, `credit-balance.test.js` (balance, ledger, no double credit, simultaneous approvals, append-only, notifications),
`client/src/utils/credit.test.js`, and two browser tests (requesting, and the approval with its balance and ledger). The audit trail has its own tests: each action with its
before-and-after values, that staff cannot read it, and that it cannot be rewritten.

## Suppliers

`/suppliers` (menu: **Suppliers**) manages the companies stock is bought from. The `Supplier` record, its API and the Orders module's quick "add supplier"
dialog already existed — this module **extends** them rather than adding a second supplier list, so every order ever placed still points at the same records.

**Page.** *Suppliers*, "Manage your product suppliers, contact details, and procurement preferences.", a green **+ Add Supplier**, a search box
("Search by company, GST, or contact...") and the table: #, Company Name (with code and type beneath), Type, Added, Last Updated, GST Number, Contact Person,
Phone, Preferred, Actions. Empty state: *No suppliers found* / "Add a new supplier or adjust the filters to see matching records."

**Search** matches company name, supplier code, GSTIN, contact person, phone and email; the term is escaped, so `.*` finds nothing rather than everything.
**Filters:** status (All / Active / Inactive), **Preferred** (All / Preferred only / Not preferred) and supplier type. **Sorting:** company name, added,
last updated and type, each way. **Paging:** 10 / 25 / 50 / 100 with "Showing page X of Y with N total records". Searching, filtering, sorting and paging all
happen in the database, so the totals and the page count describe the whole set, not the page in front of you. With no sort chosen, preferred suppliers come
first and then it is A to Z.

**Supplier code.** `SUP-0001`, `SUP-0002` … allocated by the server when the form leaves it empty, unique per organization, and accepted (upper-cased) when
typed. `npm run migrate` gives codes to suppliers created before this module (`scripts/migrate-suppliers.js`, idempotent).

**Add / Edit** is one form in four sections: *Company* (name\*, code, GSTIN, PAN, type — manufacturer / distributor / wholesaler / stockist / other —, website,
preferred, status), *Contact* (contact person\*, phone\*, alternate phone, email, alternate email), *Address* (line 1\*, line 2, country, state, city, PIN,
landmark) and *Procurement* (payment terms — advance / cash on delivery / 7 / 15 / 30 / 45 days / custom —, credit period, minimum order value, preferred
delivery time, default branch, notes). Everything is checked in the browser and again on the server: GSTIN, PAN (`ABCDE1234F`), 6-digit PIN, email, phone and
website formats, and a unique supplier code. **Editing changes only what the form sent** — a field left out keeps its value — and orders keep the supplier
snapshot taken when they were placed, so history never changes. `updatedBy` / `updatedByName` are recorded.

*Two GST numbers the same* is a **warning, not a refusal** (a group can trade under one registration, and the Orders module has always allowed it): the save
succeeds and names the other supplier.

**Payment terms reach the order form.** Picking a supplier on a new purchase order starts its payment terms off from how that supplier is normally paid —
advance stays advance, cash on delivery stays COD, and any number of days (7 / 15 / 30 / 45 / custom) means the order is on **credit** — with a line underneath
saying where the suggestion came from. It is only a starting point: changing the terms sticks, and editing an existing draft is never touched. A supplier whose
terms nobody has chosen suggests nothing.

**Details** shows the company, contact, address and procurement blocks and — computed live from this organization's own orders and goods receipts, never stored
— purchase orders, pending orders, goods receipts, total purchases, outstanding payable and the last purchase date. A supplier with no history shows zeros and
"—"; nothing is invented. Buttons: *Edit Supplier*, *View Purchase History* (Orders filtered to them) and *Create Purchase Order* (the order form with the
supplier already chosen).

**Purchase history** (in the details view) is one row per purchase order, read from the existing Orders and Goods Receipts — there is no second history to keep
in step: purchase order number, purchase date, expected date, the date the last delivery arrived, total, paid, outstanding (exactly as the order records them —
nothing here pays anything), the order's status and how much of it has been received, with a link that opens the order. Drafts are left out; a cancelled order
stays, labelled as cancelled.

**Preferred** is a flag on the record, set and cleared from the table behind a confirmation; it changes nothing else — not the status, not the payment terms.
Preferred suppliers carry a star badge and are listed first.

**Status.** Active or Inactive, with a badge and a confirmation before either change. An inactive supplier keeps everything it has, disappears from the supplier
picker on new orders, and is refused by the server if an order is attempted anyway (`SUPPLIER_INACTIVE`). Deactivating is refused while orders with them are
still open. Nothing historical is touched.

**Deleting** is only for a supplier nothing refers to. The server checks purchase orders (which carry the payments recorded against them), goods receipts,
supplier invoices and any AI Billing goods receipt still being prepared; if any exist, the delete is refused with "… can't be deleted: it has purchase orders.
Deactivate it instead — its history is kept." Deactivating is this module's soft delete: no financial or inventory record is ever removed. Deleting needs
`settings:manage`; adding, editing, marking preferred and changing status need `inventory:write`; reading needs `inventory:read`.

| Method and path | Needs | What it does |
| --- | --- | --- |
| `GET /api/suppliers[?search=&active=active\|inactive\|all&type=&preferred=&sort=name\|createdAt\|updatedAt\|supplierType&dir=&page=&limit=]` | `inventory:read` | the list, filtered, sorted and paged in the database |
| `GET /api/suppliers/:id` | `inventory:read` | one supplier with its statistics and default branch name |
| `GET /api/suppliers/:id/purchases[?page=&limit=]` | `inventory:read` | their purchase history, read from the orders and goods receipts themselves |
| `POST /api/suppliers` | `inventory:write` | add one (company, contact person and phone are required) |
| `PUT /api/suppliers/:id` | `inventory:write` | edit; only the fields sent are written |
| `POST /api/suppliers/:id/preferred` `{ preferred }` | `inventory:write` | mark or unmark preferred |
| `POST /api/suppliers/:id/status` `{ status }` | `inventory:write` | activate or deactivate |
| `DELETE /api/suppliers/:id` | `settings:manage` | only when nothing refers to the supplier (409 `IN_USE` otherwise) |

**Database:** `Supplier` gains `code`, `supplierType`, `website`, `isPreferred`, `pan`, `altPhone`, `altEmail`, `address.country`, `address.landmark`, a
`procurement` block (payment terms, credit period, minimum order value, preferred delivery time, default branch, notes) and `createdByName` / `updatedBy` /
`updatedByName`; new unique index on (organization, code).
**Audit:** `SUPPLIER_CREATE`, `SUPPLIER_UPDATE` (with the fields that changed), `SUPPLIER_PREFERRED`, `SUPPLIER_ACTIVATE`, `SUPPLIER_DEACTIVATE`, `SUPPLIER_DELETE`.
**Tests:** `server/tests/suppliers.test.js` (25), `client/src/utils/supplierForm.test.js` (12) and a browser test covering the page, search, validation,
preferred, details, editing, deactivating and both kinds of delete.

## Dashboard analytics
All figures are computed live from MongoDB, per organization (`GET /api/dashboard/…`: `overview`,
`monthly-sales`, `stock-levels`, `recent-activity`, `alerts`). Timestamps are stored in UTC; "today" and
"month" are the organization's local day/month (`timezone`, default **Asia/Kolkata**).

| Figure | Rule |
|---|---|
| **Sales** | A sale is a **completed invoice**. `draft`, `cancelled` and `reversed` never count. Revenue is the invoice `total` — payments are never summed, so retries/duplicates can't inflate it. |
| **Today's Revenue** | Completed sales whose `invoiceDate` falls on the current local business day. |
| **Total Revenue / Total Invoices** | Completed sales in the organization's reporting period: `fiscal_year` (default, starts April), `calendar_year` or `all_time` (`settings.reportingPeriod`, `fiscalYearStartMonth`). Optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` overrides it. |
| **Low Stock Alerts** | Active medicines whose *available* stock is strictly **below** their reorder level. Available stock = units in **unexpired** batches. |
| **Monthly sales** | Last 6 months (`?months=1–24`), zero-filled, bucketed by local month. |
| **Stock chart** | Active medicines with the most available stock (`?limit=1–20`). |
| **Recent activity** | Latest organization events (`?limit`, `?from`, `?to`); failed-login noise is hidden. |

Duplicate protection: `POST /api/invoices` accepts an `idempotencyKey`; the same key never creates a second
invoice or deducts stock twice (a replay returns 200 with the original invoice).
Invoice reports use indexes on `(organizationId, status, invoiceDate)`; run `npm run migrate` on existing data.

## Business Analytics

A reporting module over the records the rest of the system already keeps. There is no reporting copy of anything:
every figure is aggregated in MongoDB from invoices, orders, returns, reversals, transfers and batches, so a report
can never drift from the ledger. Nothing is computed in the browser, and no endpoint sends a collection to the client
to add up.

**Permission:** `reports:read` for every endpoint and every export — the project's existing permission for exactly
this, rather than a second vocabulary. **Isolation:** `organizationId` always comes from the signed-in user's record;
a person assigned to particular stores sees only those stores, and asking for another store's figures is a `403`
(`BRANCH_FORBIDDEN`), never a quietly empty answer. **Time:** timestamps are stored in UTC; a day, week and month
boundary is the organization's own timezone (`settings.timezone`, default **Asia/Kolkata**), and `from` / `to` are
inclusive calendar days.

### The definitions

These are stated once, in `server/services/analytics.service.js`, because every screen quotes them.

| Figure | Rule |
|---|---|
| **Gross sales** | Sum of `invoice.total` of **completed** invoices whose `invoiceDate` falls in the period. GST-inclusive — what the customer was billed. `draft`, `cancelled` and `reversed` never count. |
| **Sales returns** | Sum of `returnValue` of returns **accepted** in the period (`approved`, `refund_pending`, `refunded`, `completed` — never `pending` or `rejected`). The value of the goods, not the refund, so a refund not yet paid out still reduces what was sold. |
| **Net sales** | Gross sales less sales returns. |
| **COGS** | Sum of (units sold x the `purchasePrice` of the **batch** each line came out of) — a cost snapshot taken when the stock was received, so this is what those exact units cost, not an average. Units that came back **and were restocked** are taken off again at the same batch cost; units returned damaged are not, because that stock was consumed. |
| **Gross profit** | Net sales less COGS. Sales are tax-inclusive while batch costs are not, so this is a **trading margin**, not a tax-adjusted one. |
| **Purchases** | Sum of `order.grandTotal` of orders **placed** in the period (`pending`, `approved`, `ordered`, `partially_received`, `received`). A draft is not a purchase; a cancelled order is not either. |
| **Receivables** | Sum of `invoice.due` over all completed invoices **as they stand now**. A balance, not a period figure — the screen says so. |
| **Net profit** | **Not reported.** It needs operating expenses (rent, salaries, utilities), which the system does not record. The API returns `notes.netProfit: null` with the reason, and the page prints it rather than guessing. |

Stock moved between the organization's own stores is **never** a sale or a purchase: it is in none of these figures.
Comparisons are against the period immediately before, of exactly the same length.

### Analytics overview — `GET /api/analytics/overview`

Query: `from`, `to`, `branchId` (all optional; the default period is the current month to date).

Returns the eight headline figures each with its previous-period value, percentage change, direction and the
definition behind it (shown on the card under an **i**); the revenue series; and the transaction mix. The series is
bucketed to suit the period — by **day** up to 31 days, by **week** up to 120, by **month** beyond — and returns a
point for **every** bucket, so a day with no trade is a zero rather than a gap and nothing is invented to fill it.

### Daily Transaction Report — `GET /api/analytics/transactions`

Every business document of the period in one list, read straight from the collections that own them, unioned and then
filtered, sorted, counted and paged **in the database**.

| Row | Is | Dated by | `amount` |
|---|---|---|---|
| `sale` | an Invoice | `invoiceDate` | `total`, GST included |
| `purchase` | an Order placed with a supplier | `orderDate` | `grandTotal` |
| `salesReturn` | a SalesReturn | `returnDate` | `returnValue` — the goods, not the refund |
| `purchaseReturn` | a reversed goods receipt | `reversedAt` | chargeable units removed, at the unit cost on the order line they came from |
| `transfer` | stock moved between your own stores | `transferDate` | the stock's **batch cost**, shown so a movement can be judged |

`countsAsTrade` is what keeps the money honest: only a completed invoice, an order actually placed, an accepted return
or a reversal contributes to a total. A **draft is never listed** — nothing was issued. A **cancelled or rejected**
document **is** listed, because it happened, but adds nothing to any total and is marked as such on screen. A
transfer is never trade. Sales returns and purchase returns carry no store of their own, so theirs is read from the
invoice / order they belong to; a return carries no tax breakdown of its own, so those cells are empty rather than
zero.

Query: `from`, `to`, `branchId`, `type`, `status`, `paymentMode`, `search` (reference, related reference, party name
or phone), `sortBy` (`date` | `amount` | `reference` | `type`), `sortDir`, `page`, `limit` (max 100). An unrecognised
value is a `400`, never silently ignored, so a filter can never appear to work when it does not. The response carries
its own filter vocabulary in `options`, so the dropdowns can only offer values the validator accepts. The `summary`
and `totals` describe the **whole matching set**, not the page on screen, and because sales and purchases run in
opposite directions there is no single "total amount": each side is given separately, already net of what came back.

### Export — `GET /api/analytics/transactions/export`

The same question, answered with **every** matching row rather than the page on screen, as CSV inside the usual
`{ success, data }` envelope (as the inventory import template is) so the browser's own session applies. The file
opens with the organization, the store, the period, the timezone and the filters that were applied, so a printed copy
says what it is a report of. Capped at 20,000 rows (`EXPORT_TOO_LARGE`): beyond that the period is too wide to be a
document, and the message says to narrow it.

### Sales Report — `GET /api/analytics/sales`

One question asked once: the period, the store and the filters. The figures, the five cuts behind the charts and the
paged table all come from the same `$match`, so no part of the page can answer a different question from another.

Query: `from`, `to`, `branchId`, `status` (any invoice status except `draft`), `paymentMode` (`Cash` | `UPI` | `Card` |
`Credit`), `cashier` (a user id), `customer` (name or phone), `search` (invoice number), `sortBy`
(`date` | `amount` | `invoiceNo` | `customer` | `due`), `sortDir`, `page`, `limit` (max 100). Unrecognised values are
a `400`. `options` carries the vocabulary the dropdowns may offer, including the people who actually billed in the
period.

Returns seven figures — total sales, net sales, invoices, average invoice, total discounts, total GST and sales
returns — each with its previous-period value and definition; `charts.overTime` (bucketed as the overview is, every
bucket filled), `charts.byPaymentMode`, `charts.byBranch`, `charts.byCategory` and `charts.topMedicines` (the ten
biggest by line value); and one page of invoices. **Money is always conditional on the invoice being completed**: a
cancelled or reversed invoice is listed, and marked, but adds nothing to a figure or a chart. Category comes from the
catalogue (an `Attribute`), so a medicine with none reads as *Uncategorised* rather than being dropped.

### Purchase Report — `GET /api/analytics/purchases`

Query: `from`, `to`, `branchId`, `status` (any order status except `draft`), `paymentStatus`, `supplierId`, `search`
(order number, the supplier's own reference, or supplier name), `sortBy` (`date` | `amount` | `orderNo` | `supplier` |
`due`), `sortDir`, `page`, `limit`.

Returns total purchase value, orders placed, suppliers bought from, purchase returns, outstanding supplier payments,
average order value and purchase GST — again each against the previous period — plus `charts.overTime`,
`charts.bySupplier` (with what is owed to each), `charts.byCategory` (the snapshot the **order line** recorded, so a
report of what was bought cannot change because the catalogue was re-filed later) and `charts.byBranch`. Purchase
returns are reversed goods receipts, valued at the unit cost on the order line the stock came from — the same
valuation the Daily Transaction Report uses, shared as `reversalAmount()` rather than written twice. Outstanding
supplier payments record what was **agreed**, not a bank balance, and the card says so.

### Report exports — `GET /api/analytics/{sales,purchases}/export`

The same question, answered with **every** matching row, as CSV in the usual envelope and capped at 20,000 rows
(`EXPORT_TOO_LARGE`). Each file opens with the organization, the store, the period, the timezone and the filters in
force, and carries a *Counts as a sale / Counts as a purchase* column, so a printed copy can never be mistaken for a
list of trade when some of its rows are not. CSV is written by `server/utils/csv.js`, which quotes anything that would
break a row and defuses anything a spreadsheet would run as a formula.

### Profitability — `GET /api/analytics/profitability`

Query: `from`, `to`, `branchId`. Nothing else: every figure on a profit statement follows from the same two things,
and a filter that narrowed only part of it would make the statement untrue.

The headline figures come from the very same `figuresFor()` the overview uses, so the two screens cannot disagree —
there is one definition of gross profit in this codebase, in `analytics.service.js`. The response adds a `statement`
array (gross sales → less returns → net sales → less COGS → gross profit → **expenses: not recorded** → **net profit:
not available**), a bucketed `charts.trend` of net sales, COGS and gross profit, and profit split `byBranch`,
`byCategory`, `topMargin`, `lowMargin` and `topProfit`.

| Figure | Rule |
|---|---|
| **COGS** | Σ (units sold × the `purchasePrice` of the batch the line came out of) − Σ (units returned **and restocked** × the same batch cost). A damaged return is **not** credited back: that stock was consumed and is a real cost of trading. |
| **Gross margin** | Gross profit ÷ net sales. Zero net sales has no margin and is reported as `null`, not 0%. |
| **Net profit** | **Not reported**, and deliberately not approximated by sales − purchases: stock bought and not yet sold is an asset, not an expense, so that figure would swing with the buying cycle and mean nothing. |

Two levels of figure, stated in `notes.lineLevel`: the headline is invoice-level, while the cuts by category and
medicine can only come from invoice **lines**, which sum to the invoice totals apart from per-invoice rounding. A
medicine whose batch carries no purchase price is listed with `costKnown: false` but kept **out** of the margin
rankings — otherwise free stock would top the table at 100%; `notes.unknownCost` says how many were held back.

### Inventory analytics — `GET /api/analytics/inventory`

Query: `from`, `to`, `branchId`, `categoryId`, `manufacturer`, `stockStatus` (`in_stock` | `low` | `out` |
`near_expiry` | `expired` | `quarantined`), `expiryWindow` (`expired` | `30` | `60` | `90` | `beyond90`), `search`
(medicine, batch number or SKU), `sortBy` (`value` | `quantity` | `medicine` | `expiry` | `cost`), `sortDir`, `page`,
`limit`.

**Two kinds of figure share this endpoint and the response keeps them apart.** A *stock position* — units, valuation,
low stock, out of stock, near expiry, expired value — is as it stands **now**; a date range cannot change it, and
those KPIs carry `change: null` so the card says "as it stands now" rather than printing a misleading 0%. A
*movement* — units in, units out, the ledger chart, and what sold fast or slowly — is a period figure and follows the
dates. `notes.stockHasNoPeriod` states this on screen.

| Figure | Rule |
|---|---|
| **Inventory valuation** | Σ (`availableQuantity` × `batch.purchasePrice`) over live, unexpired, unarchived batches. **Never** MRP or the selling price: valuing stock at what you hope to sell it for books the profit before the sale. A batch with no purchase price adds nothing and is counted in `notes.noCost`. |
| **Expired stock value** | The same sum over batches past their expiry date that still hold units — reported separately, never inside the valuation, and never as sellable. |
| **Low / out of stock** | Per **medicine**, not per batch: sellable units across the stores in scope at or below that medicine's own `reorderLevel` (low) or zero (out). A medicine with no lot at all is out of stock. |
| **Movement** | From the append-only `StockMovement` ledger: positives are stock in, negatives stock out, with transfers reported separately because moving stock between our own stores is neither a purchase nor a sale. |
| **Slow movers** | Built from stock **on hand**, not from sales — a list of slow sellers that only contains things that sold is no use. `daysOfCover` is `null` when nothing sold, because "forever" is not a number. |

"Near expiry" uses the organization's own third expiry threshold, so this screen and Expiry Intelligence agree.

### More report exports — `GET /api/analytics/{profitability,inventory}/export`

Profitability exports **every medicine** sold in the period with its own margin (not the ten on screen), under a
heading that carries the whole statement and the words *Net profit: Not available — operating expenses are not
recorded*. Inventory exports the whole filtered stock register at cost, with the valuation method and a file total in
the heading, capped at 25,000 batches.

### GST report — `GET /api/analytics/gst`

Query: `from`, `to`, `branchId`, `rate` (a GST percentage the invoices actually carry), `search` (invoice number,
customer or GSTIN), `sortBy` (`date` | `invoiceNo` | `taxable` | `tax` | `total`), `sortDir`, `page`, `limit`.

**This endpoint reports; it does not recalculate.** Every figure it can read comes from the tax each document stored
when it was made, and the two it cannot read are marked `derived: true` rather than passed off as recorded.

| Figure | Source |
|---|---|
| **Output tax** | The per-line snapshots on completed invoices — `items.taxableAmount`, `items.cgst`, `items.sgst`, `items.igst`, `items.taxAmount` — grouped by the line's own `items.gstPercent`. Retail prices here are **GST-inclusive**, so tax was split out of the price when the bill was made (`utils/billMath.js`); it is never added on top. A cancelled or reversed invoice charged nobody any tax and is excluded. |
| **Sales return adjustment** | **Derived.** A return stores no tax of its own, so the tax-inclusive refund value of each returned line is split using the rate on the invoice line it is returned against: `tax = amount × rate ÷ (100 + rate)`, CGST/SGST or IGST exactly as the original invoice. A line that cannot be matched to an invoice line is reported at rate 0 and counted in `notes.unmatchedReturnLines` — never guessed. |
| **Input tax** | `items.gstAmount` on orders actually placed, by line rate, plus GST on shipping and other charges (`charges.gstAmount`) as its own figure since it belongs to no product rate. Orders carry no inter-state flag, so input tax is **one** figure and `notes.inputSplit` says why. |
| **Purchase return adjustment** | **Derived.** A reversed goods receipt, valued exactly as the Daily Transaction Report values it, with that order line's rate split back out. |
| **Net position** | (output − sales returns) − (input − purchase returns), labelled *payable* or *input tax credit*. `notes.netPosition` states that it counts only what this system records — no opening credit, reverse charge or ineligible credit. |

Round-off is **never** counted as tax: taxable + tax is the payable before rounding, and `roundOff` is reported on its
own so the figures reconcile against invoice totals. HSN codes come from the medicine records **as they stand now** —
invoice lines do not snapshot an HSN code — which `notes.hsnSource` says on screen; a medicine with no code is
grouped under *Not recorded* rather than dropped.

The response also carries `byRate`, `returnsByRate`, `inputByRate`, the HSN summary and a paged invoice-level detail
table. Nothing on the screen or in a file is allowed to look like a return: the page opens with a warning panel, and
`notes.disclaimer` ("not a GST return — reconcile against your accounting records before filing") is repeated in the
CSV heading and at the top of the printed sheet.

`GET /api/analytics/gst/export` carries the statement, the rate breakdown and the HSN summary in its heading, then
every matching invoice (capped at 20,000). **Print summary** prints the statement, rate breakdown and HSN summary
only — deliberately not the invoice list, because that list is paged and a printed page one of forty would read as
the whole thing; the sheet says the CSV carries every invoice.

### Customer Insights — `GET /api/analytics/customers`

Query: `from`, `to`, `branchId`, `search` (name or phone), `owing` (`true`/`false`), `activeOnly`, `sortBy`
(`spent` | `orders` | `last` | `due` | `name`), `sortDir`, `page`, `limit`.

**There is no customer record in this system**, so a customer IS a phone number on an invoice — the one field a
person keeps between visits. Two visits under one number are one customer, and the most recent spelling of the name
wins. A sale with **no** phone number is not a customer at all, not even collectively: it is summed into one
*Not identified* row (`walkInRow`, `summary.walkIn`), excluded from every count, ranking and average, so the
anonymous share of trade is visible instead of quietly distorting the averages.

| Figure | Rule |
|---|---|
| **Total customers** | Distinct phone numbers that have ever bought. A standing figure — `change: null`, and the card says "as it stands now". |
| **Active** | Bought at least once in the period. |
| **New** | **First ever** completed invoice falls inside the period — looking only at the period could not tell a new customer from a returning one. The growth chart is built from these first-ever purchases. |
| **Repeat** | Active customers with two or more invoices in the period. |
| **Outstanding** | Σ `invoice.due` over **all** that customer's completed invoices as it stands now, which is why it does not move when the period changes. |

It is **one aggregation**: every completed invoice is grouped by phone number once into a row carrying both all-time
and period figures, and the summary, rankings, frequency bands, growth curve and paged table are all `$facet`
branches over those same rows — which is why a balance can sit beside a period figure without a second query and
nothing on the page can disagree with anything else.

Contact details respect the existing vocabulary rather than a new one: phone numbers and GSTINs are returned only to
somebody with **`billing:read`**, who can already open the invoices those details come from. Without it every figure
is identical and the contacts are withheld (`permissions.contacts: false`, `notes.contacts`) — a restriction, not a
quietly different report.

### Supplier Performance — `GET /api/analytics/suppliers`

Query: `from`, `to`, `branchId`, `supplierId`, `search` (name, phone or GSTIN), `owing`, `activeOnly`, `sortBy`
(`value` | `orders` | `owed` | `last` | `name`), `sortDir`, `page`, `limit`.

Grouped by the supplier record. Orders placed before the Suppliers module existed carry only a name, so those group
by that name and come back `linked: false` — they are still trade and still owed for, and dropping them would
understate the figures (`notes.unlinked` counts them). *Total suppliers* counts the supplier **list**; `summary.ordered`
counts who was actually ordered from.

Beside purchase value sit the two figures that actually distinguish a good supplier: **return rate** (reversed
deliveries ÷ purchases, valued exactly as the Daily Transaction Report values them) and **outstanding** (what the
orders record as unpaid, as a balance now — never a bank statement). **Lead time** averages only the orders in the
period that have been **received**; one still on its way is excluded rather than counted as fast. Returns live in
another collection and are joined on after the page is cut, so the table cannot be sorted by them — `notes.returns`
says so and `sortBy=returns` is a `400` rather than a column that silently sorts by nothing.

### Branch Performance — `GET /api/analytics/branches`

Query: `from`, `to`, `branchId`, `sortBy` (`sales` | `netSales` | `profit` | `margin` | `invoices` | `average` |
`returnRate` | `purchases` | `stock`), `sortDir`. **No paging**: an organization has tens of stores, and a comparison
showing only some of them would not be a comparison.

One row per store with total sales, sales returns, return rate, net sales, COGS, gross profit and margin, invoice
count, average invoice, purchases, receivables, supplier debt and inventory value — every one of them from the
definitions stated once in `analytics.service.js`, and the current and previous periods run the identical code, so a
store's arrow means what the overview's arrow means. A store with **no trade is still listed**: "that branch sold
nothing this month" is usually the answer somebody came for. A sale recorded against no store, or against a store
since removed, still appears (`known: false`) rather than being hidden and making the totals not add up — and the
totals are the sum of the rows, so table and headline cannot disagree. Inventory value is a **position**
(`notes.stockHasNoPeriod`); transfers between the organization's own stores are in none of these figures.

`GET /api/analytics/{customers,suppliers,branches}/export` export the full filtered list (customers and suppliers
capped at 20,000; branches end with an **All stores** total line). The customer file states how a customer is
identified and whether contacts were included.

### Business Insights — `GET /api/analytics/insights`

Query: `from`, `to`, `branchId`, `limit` (max 30).

Not a model, and no outside service: every insight is a **deterministic rule** over the figures the reports already
compute — the same `figuresFor()` the overview quotes, the same inventory position, the same definitions. An insight
can therefore always be reproduced by opening the report it links to, and if the two ever disagree that is a bug
rather than a difference of opinion.

Three rules the rules follow:

1. **Say what happened, never why.** "Sales fell 14% against the previous 30 days" is a fact; "because footfall
   dropped" is a guess this system has no data for. Nothing claims a cause.
2. **Carry the evidence.** Each insight has a `metric` (the figure it rests on, with its format), `evidence` (the
   figures behind it), the period it is about, and a `link` + `linkLabel` to the report that proves it.
3. **Stay quiet when the data cannot support a statement.** Below a threshold there is no insight, not a hedged one.
   An empty list is an answer, and `examined` says what was looked at so it reads as "nothing to report" rather than
   "nothing worked".

Rules currently implemented: sales change, gross-profit change, an unusually busy bucket inside the period, best
seller, stock that sold nothing, batches near expiry, expired stock still on the shelf, products returned on an
unusual share of units sold, medicines both low and selling (a buying list rather than a warning), medicines with
nothing sellable, the best-billing store, a store whose sales fell, the largest customer balance, and supplier debt.
Severity orders the list — `critical`, `warning`, `opportunity`, `positive`, `info` — and every threshold that
triggered a rule is published in the response (`thresholds`) so the person being advised can argue with it.

The panel sits at the top of the overview and is fetched as a **separate** question: if a rule cannot be worked out,
the figures on the page are unaffected and the panel says so.

### Exports, printing and permissions

Every report exports **CSV** of the full filtered set — not the page on screen — as text inside the usual
`{ success, data }` envelope, so the browser's own session and CSRF handling apply and the file saves without a second
request. Each file opens with the organization, the store, the period, the timezone and the filters in force; money is
INR with two decimals; row caps are 20,000 (25,000 for the stock register) with `EXPORT_TOO_LARGE` and a message
saying how to narrow it. **Excel (.xlsx) is deliberately not offered**: it would mean adding a spreadsheet dependency
for a file Excel already opens, and a fake "Export Excel" button that produced CSV would be worse than none. **Print**
is offered where a sheet is genuinely used on paper — the expiry register and the GST summary — and the GST sheet
prints the summary only, saying so, because the invoice list is paged and a printed page one of forty would read as
the whole thing. There is no PDF: the print dialog already produces one.

**Permissions.** Every analytics endpoint and every export requires `reports:read`, enforced in the router. The
plan's suggested `analytics.*` vocabulary was deliberately **not** added — a second vocabulary for the same privilege
is a way for the two to drift apart. Customer contact details additionally require `billing:read`, on the grounds
that whoever may open the invoice may read the phone number on it; without it the figures are identical, the contacts
are withheld, and both the screen and the export say so. `server/tests/analytics-permissions.test.js` reads the GET
routes **off the router itself** and asserts each one is a 403 without `reports:read`, a 401 unauthenticated, and
never returns another organization's data — so a new analytics route is covered the moment it is added.

### Low Stock Report — `GET /api/analytics/low-stock`

Query: `branchId`, `status` (`out` | `critical` | `low`), `search` (medicine, salt or manufacturer), `categoryId`,
`sortBy` (`urgency` | `medicine` | `available` | `threshold` | `shortfall` | `cost`), `sortDir`, `page`, `limit`
(up to 500, so the printed sheet can be the whole list).

**This report has no date range, and that is not an omission.** Everything on it is a position — what is on the
shelves at this moment — so a date range is **refused with a 400** rather than accepted and ignored: a control that
looks like it does something and does not is worse than no control. The screen opens with a store selector instead
of a period picker and says why.

What counts as low is **not decided here**. `LOW_ON_STOCK` and `OUT_OF_STOCK` are defined once in
`analyticsInventory.service.js` and imported, so this report and Inventory Analytics cannot drift into two answers
to "how many medicines are low" — a test asserts the two agree. Both are per **medicine** across the stores in
scope, never per batch: a buyer orders a medicine, not a lot.

| Status | Rule |
|---|---|
| **Out of stock** | Zero **sellable** units — including a medicine with no batch at all, which is exactly what being out of stock means to the person ordering. |
| **Critical** | Still has stock, but below **half** its reorder level. An item already at zero is counted as out, not critical — it is worse. |
| **Low** | At or below its reorder level. "At" counts: a medicine sitting exactly on its minimum needs attention. |

Stock is **sellable**, not "on hand": units reserved for somebody else, in an inactive lot, or already expired
cannot be sold to the next customer, so they are not counted — the same `SELLABLE` the rest of the module uses.

Two columns are **suggestions, labelled as such**. *Suggested order* is `reorder level − sellable`: arithmetic that
returns the shelf to its own stated minimum, with no view of how fast the medicine sells. *Estimated cost* values
that order at the **last price actually paid** for the medicine. Neither is ever invented: a medicine with no
reorder level gets no suggestion (there is no minimum to return to), and one nobody has ever bought gets no cost —
the cell says "no price on record" instead of ₹0, which would read as free. The same applies to the **total**:
`summary.costKnown` is false when nothing on the list can be priced, and the screen, the printed sheet and the CSV
all read that one flag, so none of them can show a confident zero for money that is simply unknown. When only part
of the list can be priced, `costIsPartial` says so and the total names how many it excludes.

The three cards are computed **before** the status filter narrows the table — otherwise filtering to "out of stock"
would make the other two cards read zero. **Print report** produces a purchase worksheet: the whole filtered list,
the position's exact timestamp in a box (a stock position on paper is dangerous without one), and an "ordered"
column and signature line, because the sheet exists to be worked through. `GET /api/analytics/low-stock/export`
carries the same list as CSV, and its heading states plainly that the file is a position rather than a period —
`exportHeader` now prints that line for any report with no period instead of inventing a date range.

### Document numbering and the invoice template

**A document number is issued exactly once.** Sales invoices, credit notes and purchase orders are numbered through
`services/documentNumbering.service.js`, which takes the sequence from an atomic `$inc` on one counter document, inside
the same transaction as the document — so a rolled-back sale rolls its number back too. The sequence lives in the
counter, never parsed back out of the printed text, which is why **changing a prefix renames what comes next and cannot
reach an invoice that exists**.

| Setting | Effect |
|---|---|
| prefix / separator / suffix / padding | The shape of the NEXT number. A sequence wider than its padding is never truncated. |
| start | Raises the counter to `start - 1` with `$max` (atomic, idempotent, never lowers). A start **somebody lowers** below an issued number is refused with `NUMBER_ALREADY_ISSUED`; one nobody touched is ignored. |
| include financial year | Prints `25-26`. |
| reset every financial year | Gives each year its own counter (`invoice\|fy:2026-27`). The year turns over at **local midnight in the organization's timezone**: 23:59 IST on 31 March is last year's, 00:00 IST on 1 April is the new one's — 18:30 UTC, handled by the same code the reports use. |
| per-store numbering | Each store gets its own counter (`invoice\|b:<id>`), falling back to the organization's settings until configured. |

With the default configuration the counter key is `invoice` / `order` / `salesReturn` — byte-identical to what the
system always used — so an organization that never opens the screen sees no change at all. Turning on per-store numbering
or a yearly reset points billing at a counter that has never existed, which starts at zero; unless the printed format also
changed that would re-issue numbers already on paper, so **every save of the invoice settings raises every counter it can
reach to the highest number that scope has issued under that series' own format** (`seedCounters`, audited as
`SETTINGS_COUNTERS_SEEDED`).

**Which documents may seed a counter.** GST invoice serials are meant to be consecutive within a series and a financial
year, so a counter that *jumps* is a compliance problem even when nothing collides. A document seeds a counter only if its
number is **exactly what the series would have printed for it** — the number is parsed, then rebuilt with the series' own
formatter and compared, which covers prefix, separator, suffix, padding, leading zeros and the financial-year segment in
one check — and only if it sits no more than **1000** above the next-highest accepted number. Everything else is listed as
*needs review* with its `_id` and is **never used**. (The first version read the trailing digits off every document, so a
demo row called `EXP-DEMO-090` raised a real invoice counter from 7 to 90.) A counter that already stands above every valid
document is reported as a **gap** and left alone: lowering a counter is a decision for a person, because the numbers above
it might be real.
`node scripts/seed-invoice-counters.js --dry-run` shows what it would do without writing, and no script or save ever
reads a document for anything but its number or modifies one.

The printed invoice is **one pure function**, `client/src/utils/invoiceTemplate.js`. The settings screen's live preview and
the invoice handed to a customer are the same code: the preview feeds it a sample bill marked PREVIEW, the till feeds it a
real one. A narrow thermal roll gets a different layout, not a scaled one — columns and the accent colour are dropped
because they print as grey smudges. Everything printed about a real sale comes from what the server saved; nothing is
recalculated in the browser. The payment QR (`upiQr.js`, inline SVG, level M) appears only with a saved UPI ID, the toggle on,
a positive amount, and never on a credit note.

### Common Settings, and what billing and inventory read from them

**The promise: defaults keep today's behaviour exactly.** An organization that never opens Common Settings bills,
adjusts stock and reads its dates exactly as it did before any of this existed. That is not left to good intentions:
`server/tests/settings-phase4.test.js` runs the same working day (a medicine with two lots, a cash sale that spans
them, a credit sale to nobody in particular, a discounted sale) through three organizations — one with **none** of the
new settings at all, one the migration has run over, one created fresh — and asserts the results are deep-equal.

Getting there meant correcting three defaults the first version of the migration had wrong, because it had written
what seemed sensible rather than what the system did:

| Setting | Wrong default | What the system actually did | Now |
|---|---|---|---|
| Date format | `dd/MM/yyyy` | `06 Nov 2026` | `dd MMM yyyy` |
| Phone required on credit | on | never required | **off** |
| Default credit period | 15 days | no due date existed | **0** (no due date) |

`scripts/lib/settingsMigration.js` makes the correction **once**, guarded by `settings.general.defaultsVersion`, so a
re-run can never overwrite a choice somebody made afterwards.

| Setting | Read by | Effect |
|---|---|---|
| `requireCustomerPhoneOnCredit` | `invoice.service.js` `createInvoiceOnce` | A credit sale with no phone is refused `400 CUSTOMER_PHONE_REQUIRED` **before any stock moves** — enforced on the server, so it holds however the sale is rung up. Cash sales are unaffected. |
| `defaultCreditDays` | `invoice.service.js` | A credit sale that still has a balance gets `dueDate = sale + N days`. 0 = none. Printed on the invoice. |
| `roundOffNearest` (+ `posRoundOff`) | `invoice.service.js` -> `billMath.computeBill` | `true`/`1` = nearest rupee (unchanged), `0.5` = nearest 50 paise. Held in whole paise. Mirrored in `client/src/utils/billMath.js`. |
| `defaultLowStockThreshold` | `medicine.service.js` `createMedicine`, `import.service.js` | A new medicine with no reorder level given starts here (10 until changed). Existing medicines are never touched; an explicit level — including 0 — always wins. Updating a medicine is unchanged. |
| `settings.expiry.*` | Expiry Intelligence, analytics, **and now the bell** (`dashboard.service.js`) | The notification bell's look-ahead is the largest expiry threshold (90 by default) instead of a hard-coded 90. One set of numbers, edited here, not a copy. |
| `notifications.*` | `dashboard.service.js` `getAlerts` -> bell | Each alert can be hidden from the bell. The lists and counts are always returned — the dashboard cards read them too — so turning one off quietens the bell, never the figures. Licence expiry and the daily summary are new bell items; the summary is only computed when it is switched on. |
| `licenseExpiryWarningDays` | `settings.service.js`, `dashboard.service.js` | How far ahead a lapsing drug licence is flagged on the profile and in the bell. |
| `timezone`, `dateFormat` | `auth.service.js` -> `client/src/utils/format.js` | **Display only.** Every date is stored as a UTC instant and is never rewritten; a test snapshots every invoice, batch and ledger date before and after a change and asserts they are byte-identical. |
| `fiscalYearStartMonth` | numbering, reporting period, the financial-year lock | **Locked once any invoice exists in the current financial year**, with the reason shown, on **both** routes that can change it (`PATCH /settings/general` and the older `PUT /organization`). Moving it mid-year would put some invoices in a year that no longer exists and let a number repeat. |

**Rules that are not settings.** Oldest stock sold first (FEFO), expired batches never sold, and stock never negative are
enforced in `invoice.service.js` in the same atomic update that takes the stock — `expiryDate: { $gt: now }` and a guard
on the unreserved units live in the update's own filter. There is no switch for any of them: the API drops an attempt to
send one, `GET /settings` lists them under `enforced` so the screen can show them locked, and a test sends
`allowExpired`, `fefo: false` and `blockExpired: false` with a sale and asserts none has any effect. A sale is the only
thing that takes stock *out to a customer* (`createInvoice`); the POS product list is read-only, an import and a delivery
only ever put stock *in*, and every one of those ends in `createBatchInTx`, which now also refuses an expiry that is not
in the future **at the write itself** — so a spreadsheet previewed on Monday and confirmed on Friday cannot slip an
expired lot in. (Confirm already re-reads the sheet against today's date; this is the second lock.)

Two things cannot be switched, and the screen says so instead of offering a toggle that would do nothing: **prices include
GST** (`billMath` only splits tax *out of* a price) and **an item discount comes off before tax**. The validator refuses
`false` for either with the reason.

**Reset invoice layout** resets the paper size, template, accent colour, print toggles and calculation choices — and
nothing else. It never touches numbering formats, terms, the counters behind your invoice numbers, or an invoice that
exists; a test asserts the counter and an issued number are unchanged afterwards.

**A bug worth knowing about.** Mongoose does not reject a `$set` of a path its schema lacks — it silently drops it. The
first version of `saveGeneral` wrote the Common Settings fields to `settings.<key>` while the schema stores them under
`settings.general.<key>`, so those saves answered `200 — saved 1 change` and persisted nothing. `saveGeneral` now maps
each field explicitly (`generalPath`), `applyPatch` refuses any path the schema does not have
(`SETTINGS_PATH_UNKNOWN`), and a test checks every field against the schema so it cannot happen again without failing.

### Pages

| Page | Route |
|---|---|
| Business Analytics (overview) | `/analytics` |
| Daily Transaction Report | `/analytics/transactions` |
| Sales Report | `/analytics/sales` |
| Purchase Report | `/analytics/purchases` |
| Profitability | `/analytics/profitability` |
| Inventory Analytics | `/analytics/inventory` |
| Expiry Intelligence | `/analytics/expiry` |
| GST Report | `/analytics/gst` |
| Customer Insights | `/analytics/customers` |
| Supplier Performance | `/analytics/suppliers` |
| Branch Performance | `/analytics/branches` |
| Low Stock Report | `/analytics/low-stock` |

Business Insights is a panel at the top of `/analytics` rather than a page of its own: it is a way into the reports, not a destination.

The overview's transaction breakdown is clickable, carrying the period and the chosen store: **Sales** and
**Purchases** open their own report, the two kinds of return open the transaction list filtered to them. A report row opens the full document in a panel, and **Open the original** goes to the module that owns
it (`/invoices`, `/orders`, `/sales-returns`, `/inventory/transfers`, each by its reference). Permissions are enforced
on the server; the client only hides links the user could not open anyway.

**Indexes:** `(organizationId, status, invoiceDate)` and `(organizationId, branchId, invoiceDate)` on invoices,
`(organizationId, status, orderDate)` on orders, `(organizationId, status, returnDate)` on sales returns,
`(organizationId, reversedAt)` on goods-receipt reversals, `(organizationId, transferDate)` on transfers, and
`(organizationId, expiryDate, availableQuantity)` on batches. Run `npm run migrate` on an existing database.

**Tests:** `server/tests/analytics.test.js` (the definitions, returns against profit, periods and bucketing,
organization isolation, store permissions) and `server/tests/analytics-transactions.test.js` (24: what appears in the
list and what counts, every filter, server-side paging and sorting, the export's contents and heading, isolation,
store permissions, Asia/Kolkata day boundaries, an empty database) and
`server/tests/settings-phase4.test.js` (33: a legacy, a migrated and a new organization billing identically, credit sales
and the phone rule enforced before stock moves, due dates, ₹0.50 rounding, FEFO and expired stock holding against a request
that tries to bend them, the write-time expiry guard, the financial-year lock through both doors, display-only timezone and
date format with a byte-for-byte snapshot of every stored date, a reset that leaves counters alone, default reorder levels,
and what the bell shows), `server/tests/invoice-numbering.test.js` (20: fifty parallel invoices through the real billing path with no duplicate and
no skipped number, two organizations billing at once, the 31 March 23:59 → 1 April 00:00 IST rollover across the UTC
boundary, a renamed prefix leaving old invoices untouched, a configured start, counters seeded when per-store numbering is
switched on, a dry run that writes nothing, and a save of an unrelated change once invoices exist),
`server/tests/analytics-low-stock.test.js` (25: a medicine exactly at its reorder level counted as low, critical
kept apart from out, a medicine with no batch still reported, reserved and expired units not counted as stock, the
suggestion withheld when there is no reorder level, the cost withheld when nothing was ever paid, a total that says
"not known" rather than zero, cards that do not follow the status filter, a date range refused, and agreement with
Inventory Analytics), `server/tests/analytics-insights.test.js` (15: silence below a threshold and on too small a base, a fall and a rise
with the evidence beside them, best seller, dead stock, near-expiry against already-expired, reorder suggestions only
for what sells, high-return products, the largest balance, store comparison only when there are two, and the shape
every insight must have), `server/tests/analytics-permissions.test.js` (6: every GET read off the router refused
without `reports:read`, refused unauthenticated, scoped to the signed-in organization, and customer contacts gated on
`billing:read` in both the screen and the export),
`server/tests/analytics-parties.test.js` (23: one phone number as one customer, an anonymous sale never counted as
one, new meaning first-ever, a balance that the period does not move, frequency bands, withheld contacts, a supplier
known only as a name on an old order, lead time from received orders only, return rate, every store compared
including one that sold nothing, rows summing to the totals, and all three exports),
`server/tests/analytics-gst.test.js` (19: tax split out of an inclusive price, CGST/SGST halving and IGST replacing
them, each rate adding back up to the total, a cancelled invoice charging no tax, the HSN summary and its source, the
returns adjustment derived from the original line's rate, input tax on placed orders only, GST on charges as its own
figure, the net position, round-off never counted as tax, the rate filter and the export's disclaimer),
`server/tests/analytics-profit-inventory.test.js` (21: the cost of the batch the units came out of, a restocked
return credited back and a damaged one not, the statement adding up, agreement with the overview, un-costed stock kept
out of the margin ranking, valuation at cost rather than MRP, a position ignoring the date range, low/out per
medicine, expired stock reported separately and never sellable, movement from the ledger, slow movers that sold
nothing, both exports) and
`server/tests/analytics-sales-purchases.test.js` (23: what counts as a sale and as a purchase, cancelled documents,
returns against net sales, that each cut adds up to the figure above it, every filter, paging, sorting, both exports,
isolation and store scope). Client: `client/src/utils/analytics.test.js` and `client/src/utils/transactions.test.js`
(17).

## Authentication
- Sign-in creates a **server-side session**. The browser gets three httpOnly cookies: a 15-minute
  access token, a rotating refresh token (only sent to `/api/auth`), and a CSRF token.
  The page renews the access token silently; the user only sees a sign-in prompt when the session ends.
- **Logout** and **password changes** revoke sessions on the server, so stolen tokens stop working at once.
  Reusing an old refresh token revokes the whole session.
- **Remember me** keeps the refresh cookie for 30 days; otherwise it is a browser-session cookie
  and the session lasts at most 12 hours. (`SESSION_HOURS`, `REMEMBER_ME_DAYS`)
- **Brute-force protection:** per-IP rate limits plus an account lockout (5 wrong passwords → 15 minutes).
- **CSRF:** state-changing requests must carry `X-CSRF-Token` (double-submit); the SPA does this automatically.
- **Password policy:** 8–72 characters with upper, lower, number and symbol.
- Endpoints: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`,
  `POST /api/auth/refresh`, `POST /api/auth/change-password`.
- "Forgot password" currently tells users to contact their administrator (no email service yet).

## Security notes
- Tenant isolation: `organizationId` always comes from the authenticated user's database record,
  never from the request. Every query is scoped to it.
- Passwords are bcrypt-hashed and never returned by the API; CORS is limited to `CLIENT_ORIGIN`.
- Set a strong `JWT_SECRET` (≥32 chars) and a real `MONGODB_URI` in production, serve over HTTPS
  (cookies are `Secure` in production), and remove `ADMIN_INITIAL_PASSWORD` after seeding.
- If the web app and API are on **different sites**, set `COOKIE_SAME_SITE=none` (HTTPS only).

## Testing
Three layers, all runnable on their own and none of them touches your development database:

| Layer | Command | What it covers |
| --- | --- | --- |
| Server (API + database) | `npm test` in `server/` | Sign-in, lockout, inactive users, expired / forged / revoked sessions, logout, token rotation, CSRF, injection and mass-assignment attempts, CORS and headers; multi-tenant isolation (read / edit / delete across organizations); inventory, batches, stock ledger, expiry, low-stock alerts, pagination and search; compounds and attributes; CSV import; an end-to-end acceptance walk-through. Uses a throwaway MongoDB. |
| Client logic | `npm test` in `client/` | Form validation, import-file checks, batch / catalog rules (pure functions). |
| Browser (real Chrome) | `npm install` then `npm run e2e` in `e2e/` | Starts its own API with demo data (port 4100) and web server (port 5200), then drives the UI on a desktop and a phone-sized screen: login / logout, sidebar, tables, search, pagination, forms and validation, CSV import, loading and error states, light / dark mode, and an automated accessibility scan (axe, WCAG AA) of every page in both themes. Screenshots go to `.tmp/e2e-shots/`. |

## Status
Built: login, dashboard, inventory (medicines, batches, compounds, attributes, CSV import), selling point,
invoices, sales returns, orders, goods receipts, AI billing, branches, credit management, suppliers, activity log,
and Business Analytics (overview and the Daily Transaction Report). Remaining analytics reports — sales, purchases,
profitability, inventory, expiry, GST, customers, suppliers, branch comparison and business insights — are next.
