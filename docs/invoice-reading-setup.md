# Connecting invoice reading (OCR + AI extraction)

**Written for:** whoever administers this installation. No code changes are needed — everything here is credentials and settings.

AI Billing works in two independent stages, and each is switched on by its own settings:

| Stage | What it does | Service | Without it |
| --- | --- | --- | --- |
| **1. OCR** | reads the uploaded PDF or photo into text, tables and invoice fields | **Google Cloud Document AI** | you can still upload the invoice and type its details while looking at it |
| **2. AI extraction** | turns that text into a structured invoice (supplier, invoice number, line items, totals) | **Google Gemini** (or OpenAI) | the OCR text is shown, and the details are entered by hand |

Everything after stage 2 — validation, product matching, the final review, the purchase order and the goods receipt — is already built and needs no setup.

The whole thing is optional. With nothing configured, the page says so and the manual path works.

---

## Part A — Google Document AI (stage 1)

Budget about 15 minutes. You need a Google account and a credit card for the Cloud project (there is a free tier; see "What it costs" below).

### A1. Create (or choose) a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top bar → the project dropdown → **New project**.
3. Name it something like `ojas-pharmacy`, then **Create**.
4. Once it is created, select it, and copy the **Project ID** from the project dropdown or the dashboard.
   It is a lowercase id such as `ojas-pharmacy-473812` — *not* the display name.

   → this is `GOOGLE_CLOUD_PROJECT_ID`

### A2. Enable billing and the Document AI API

1. **Billing** in the left menu → link a billing account to the project. (Document AI will not run without it, even inside the free tier.)
2. Go to <https://console.cloud.google.com/apis/library/documentai.googleapis.com> → **Enable**.

### A3. Create the processor

1. Left menu → **Document AI** → **Processor Gallery** (or <https://console.cloud.google.com/ai/document-ai/processors>).
2. Choose one:
   - **Invoice Parser** — recommended. It returns the invoice fields (supplier, invoice number, dates, totals) and line items, so the review screen starts fuller.
   - **Document OCR** — cheaper; text, layout and tables only. Everything still works; more is left to stage 2.
3. **Create processor** → give it a name (e.g. `pharmacy-invoices`) and pick a **region**:
   - `us` (United States) or `eu` (European Union). Pick one and remember it — a processor lives in one region only.

   → the region is `GOOGLE_DOCUMENT_AI_LOCATION` (`us` or `eu`)
4. Open the processor you just created. Its detail page shows **Processor ID** — a short hex string like `a1b2c3d4e5f6a7b8`.

   → this is `GOOGLE_DOCUMENT_AI_PROCESSOR_ID`
   (If you ever want to pin a specific processor version, copy its version id into the optional `GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION`.)

### A4. Create the service account and its key

1. Left menu → **IAM & Admin** → **Service accounts** → **Create service account**.
2. Name: `pharmacy-ocr`. **Create and continue**.
3. Role: **Document AI API User** (`roles/documentai.apiUser`). Nothing more — it does not need project-wide access. **Done**.
4. Open the new service account → **Keys** tab → **Add key** → **Create new key** → **JSON** → **Create**.
   The browser downloads a `.json` file. This file is a password: anyone holding it can spend on your project.
5. Move it somewhere the server can read and nothing else can, for example:

   ```
   D:\UshaPharmacy\server\secrets\google-document-ai.json
   ```

   `server/secrets/` and `*.json` keys are already excluded from version control by `.gitignore` — check before you commit anyway.

   → the absolute path is `GOOGLE_APPLICATION_CREDENTIALS`

---

## Part B — Gemini (stage 2)

1. Go to <https://aistudio.google.com/apikey> and sign in.
2. **Create API key** → choose the same Cloud project (or any project).
3. Copy the key (it starts with `AIza…`).

   → this is `GEMINI_API_KEY`

The default model is `gemini-2.5-flash`, which is fast and inexpensive and is what this system was built against. Override it with `GEMINI_MODEL` only if you have a reason.

*Using OpenAI instead:* set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4.1-mini`) rather than `GEMINI_API_KEY`. With both set, pick one with `AI_EXTRACTION_PROVIDER=gemini|openai`.

---

## Part C — Put the values in the server environment

Open `server/.env` (a block of commented placeholders is already waiting at the bottom) and fill in the five values:

```dotenv
GOOGLE_CLOUD_PROJECT_ID=ojas-pharmacy-473812
GOOGLE_DOCUMENT_AI_LOCATION=us
GOOGLE_DOCUMENT_AI_PROCESSOR_ID=a1b2c3d4e5f6a7b8
GOOGLE_APPLICATION_CREDENTIALS=D:\UshaPharmacy\server\secrets\google-document-ai.json
GEMINI_API_KEY=AIza...
```

Then **restart the API** (`npm run dev` in `server/`, or your service manager). The settings are read on every call, but a restart is the sure way.

Notes:
- Keep the file to one `KEY=value` per line, no quotes needed, no spaces around `=`.
- On Windows a backslash path is fine. A path with spaces does not need quotes in a `.env` file.
- Never commit `.env` or the JSON key.

---

## Part D — Check it works

1. Sign in → **Orders** → **AI Billing**.
2. The red "Invoice reading isn't connected yet" notice should be gone.
3. Upload a real supplier invoice (PDF, JPG, JPEG or PNG, up to 10 MB) → **Scan Invoice**.
4. You should see, in order: OCR progress → **OCR Results** (text, tables, pages, fields) → **Extract Invoice with AI** → the extracted invoice with confidence marks → product matching → final review → purchase order and goods receipt.

If you prefer to check the plumbing before using the UI, the API answers directly:

```bash
# with your session cookie; both report what is configured and what is missing
curl http://localhost:5000/api/ai-billing/extraction-status
```

---

## What it costs (as of writing — confirm on Google's pricing pages)

- **Document OCR**: about US$1.50 per 1,000 pages; **Invoice Parser**: about US$10 per 1,000 pages, with a monthly free allowance on the first pages.
- **Gemini 2.5 Flash**: fractions of a cent per invoice — the model only ever sees the OCR text, never the file.
- A typical one-page supplier invoice therefore costs roughly 1–2 US cents end to end.

Set `OCR_RATE_LIMIT` (default 30 scans per person per 10 minutes) if you want a firmer ceiling.

---

## If something goes wrong

The screens report the real reason; these are the common ones.

| What you see | What it means | Fix |
| --- | --- | --- |
| "Google Document AI is not set up yet. Missing: …" | one of the four variables is empty | fill it in `server/.env`, restart |
| "The Google credentials file could not be read" | `GOOGLE_APPLICATION_CREDENTIALS` points nowhere the server can read | use an absolute path; check the file exists and the service user can read it |
| "…is not a service-account key" | you downloaded an OAuth client secret, not a service-account key | redo **A4** — *Service accounts → Keys → JSON* |
| "Google Document AI did not accept the sign-in" | the key was deleted or the clock is badly off | create a new key; check the machine's time |
| "did not allow the request" (403) | the role is missing, or the API is not enabled | grant **Document AI API User**; enable the API (**A2**) |
| "could not find the processor" (404) | the processor id or the region does not match | the region in `GOOGLE_DOCUMENT_AI_LOCATION` must be the processor's own region |
| "did not accept the API key" (Gemini) | wrong or restricted key | create a fresh key; make sure it may use the model |
| Scan works, extraction does not | stage 1 is configured, stage 2 is not | set `GEMINI_API_KEY` (Part B) |

Nothing here ever changes your data: a failed scan leaves the upload exactly as it was, and you can retry or carry on by hand.
