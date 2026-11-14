import { useMemo, useState } from 'react';
import { AlertTriangle, Copy, Info, RefreshCw, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import { dateTimeFmt } from '../../utils/format';
import { confidenceLabel, fieldCount, fieldGroups, isLowConfidence, pageViews, tableRows, tableToText, warningsForPage } from '../../utils/ocrView';
import { Badge, Button, cx } from '../common/ui';
import DocumentPreview from './DocumentPreview';

const TABS = [
  ['text', 'Invoice text'],
  ['tables', 'Tables'],
  ['pages', 'Pages'],
  ['fields', 'Detected fields'],
];

/** One table, cell by cell. Low-confidence cells are marked so they are checked against the document. */
function OcrTable({ table, number }) {
  const rows = useMemo(() => tableRows(table), [table]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tableToText(table));
      toast.success('Table copied.');
    } catch {
      toast.error('Copying isn’t available in this browser.');
    }
  };
  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span className="font-semibold text-ink">
          Table {number} · page {table.pageNumber}
        </span>
        <span className="flex items-center gap-2">
          {table.rowCount} row{table.rowCount === 1 ? '' : 's'} × {table.columnCount} column{table.columnCount === 1 ? '' : 's'}
          <Button size="sm" variant="ghost" onClick={copy} aria-label={`Copy table ${number}`}>
            <Copy className="h-3.5 w-3.5" /> Copy
          </Button>
        </span>
      </figcaption>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-max border-collapse text-left text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={cx(r.header ? 'bg-subtle font-semibold' : 'border-t border-line')}>
                {r.cells.map((c, j) =>
                  r.header ? (
                    <th key={j} scope="col" colSpan={c.colSpan} className="px-2.5 py-1.5">
                      {c.text}
                    </th>
                  ) : (
                    <td
                      key={j}
                      colSpan={c.colSpan}
                      className={cx('px-2.5 py-1.5 align-top', isLowConfidence(c.confidence) && 'bg-warning/10')}
                      title={isLowConfidence(c.confidence) ? `Low confidence (${confidenceLabel(c.confidence)})` : undefined}
                    >
                      {c.text}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/**
 * OCR Results: the text, tables and (where the service detected them) fields read from an invoice, beside the untouched original. All of it is what
 * software read; it is labelled unverified and nothing here is saved, matched or posted. It is the raw material for the next step.
 */
export default function OcrResults({ ocr, upload, file, fileInfo, busy, onReprocess, onContinue, onBack, ai, hasExtraction, aiFailure, onExtract, onViewExtraction }) {
  const [tab, setTab] = useState('text');
  const [page, setPage] = useState(1);
  const pages = useMemo(() => pageViews(ocr), [ocr]);
  const groups = useMemo(() => fieldGroups(ocr.fields), [ocr.fields]);
  const found = fieldCount(ocr.fields);
  const current = pages.find((p) => p.pageNumber === page) || pages[0];

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(ocr.text);
      toast.success('Text copied.');
    } catch {
      toast.error('Copying isn’t available in this browser.');
    }
  };

  return (
    <div className="space-y-4 border-t border-line p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
            OCR Results <Badge tone="success">Completed</Badge>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Read by {ocr.provider === 'google-document-ai' ? 'Google Document AI' : ocr.provider} · {ocr.pageCount} page{ocr.pageCount === 1 ? '' : 's'} · {ocr.tables.length} table
            {ocr.tables.length === 1 ? '' : 's'} · {ocr.processedAt ? dateTimeFmt(ocr.processedAt) : ''}
            {upload?.uploadId ? ` · ${upload.uploadId}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onReprocess} disabled={busy} aria-label="Reprocess invoice">
            <RefreshCw className="h-4 w-4" /> Reprocess
          </Button>
        </div>
      </div>

      <div role="status" className="flex items-start gap-3 rounded-xl bg-subtle p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        <p>
          This is what software read from the document. It has <b>not been checked</b> and nothing has been saved, matched to your products or added to stock. Compare it with the
          original shown beside it before relying on any number.
        </p>
      </div>
      {ocr.reduced && (
        <p role="status" className="text-xs text-muted">
          Note: {ocr.reduced}.
        </p>
      )}
      {ocr.warnings?.length > 0 && (
        <ul aria-label="Reading warnings" className="space-y-1 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {ocr.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" /> {w}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {file && fileInfo && (
          <div className="space-y-2 xl:sticky xl:top-4 xl:self-start">
            <h3 className="text-sm font-bold">Original document</h3>
            <DocumentPreview file={file} type={fileInfo.type} name={fileInfo.name} />
            <p className="text-xs text-muted">{fileInfo.name} — shown as it was uploaded; it is never changed.</p>
          </div>
        )}

        <div className="min-w-0 space-y-3">
          <div role="tablist" aria-label="OCR results" className="flex flex-wrap gap-1 border-b border-line">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                type="button"
                id={`ocr-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`ocr-panel-${key}`}
                onClick={() => setTab(key)}
                className={cx(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors',
                  tab === key ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {label}
                {key === 'tables' && <span className="ml-1 text-xs font-normal">({ocr.tables.length})</span>}
                {key === 'pages' && <span className="ml-1 text-xs font-normal">({ocr.pageCount})</span>}
              </button>
            ))}
          </div>

          {tab === 'text' && (
            <div role="tabpanel" id="ocr-panel-text" aria-labelledby="ocr-tab-text" className="space-y-2">
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={copyText}>
                  <Copy className="h-3.5 w-3.5" /> Copy text
                </Button>
              </div>
              <pre
                aria-label="Full invoice text"
                className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-subtle p-3 font-mono text-xs leading-relaxed"
              >
                {ocr.text}
              </pre>
            </div>
          )}

          {tab === 'tables' && (
            <div role="tabpanel" id="ocr-panel-tables" aria-labelledby="ocr-tab-tables" className="space-y-5">
              {ocr.tables.length === 0 ? (
                <p className="text-sm text-muted">No tables were detected in this document. The text is under “Invoice text”.</p>
              ) : (
                ocr.tables.map((t, i) => <OcrTable key={`${t.pageNumber}-${t.index}`} table={t} number={i + 1} />)
              )}
            </div>
          )}

          {tab === 'pages' && current && (
            <div role="tabpanel" id="ocr-panel-pages" aria-labelledby="ocr-tab-pages" className="space-y-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Pages">
                {pages.map((p) => (
                  <button
                    key={p.pageNumber}
                    type="button"
                    aria-pressed={current.pageNumber === p.pageNumber}
                    onClick={() => setPage(p.pageNumber)}
                    className={cx(
                      'rounded-full border px-3 py-1 text-xs font-semibold',
                      current.pageNumber === p.pageNumber ? 'border-primary bg-primary/10 text-primary' : 'border-line text-muted hover:text-ink',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted">
                {current.label} of {ocr.pageCount} · {current.summary}
                {current.rotation ? ` · rotated ${current.rotation}°` : ''}
                {current.language ? ` · language ${current.language}` : ''}
                {current.confidence !== null && current.confidence !== undefined ? ` · average confidence ${confidenceLabel(current.confidence)}` : ''}
              </p>
              {warningsForPage(ocr.warnings, current.pageNumber).map((w, i) => (
                <p key={i} className="flex items-start gap-2 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {w}
                </p>
              ))}
              {current.lines?.length > 0 ? (
                <ol aria-label={`Lines on ${current.label}`} className="max-h-[24rem] overflow-auto rounded-lg border border-line text-xs">
                  {current.lines.map((l, i) => (
                    <li
                      key={i}
                      className={cx('flex items-start justify-between gap-3 border-b border-line px-3 py-1.5 last:border-b-0', isLowConfidence(l.confidence) && 'bg-warning/10')}
                    >
                      <span className="whitespace-pre-wrap break-words">{l.text}</span>
                      <span
                        className="shrink-0 tabular-nums text-muted"
                        title={
                          l.box?.length ? `Position on the page (from the top-left): ${Math.round(l.box[0][0] * 100)}% across, ${Math.round(l.box[0][1] * 100)}% down` : undefined
                        }
                      >
                        {confidenceLabel(l.confidence)}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-subtle p-3 font-mono text-xs">
                  {current.text || 'No text was found on this page.'}
                </pre>
              )}
              {current.tables.map((t, i) => (
                <OcrTable key={`${t.pageNumber}-${t.index}`} table={t} number={ocr.tables.indexOf(t) + 1 || i + 1} />
              ))}
            </div>
          )}

          {tab === 'fields' && (
            <div role="tabpanel" id="ocr-panel-fields" aria-labelledby="ocr-tab-fields" className="space-y-4">
              <p className="text-xs text-muted">
                {found.found === 0
                  ? 'The service did not detect any invoice fields in this document (a plain text reader does not). Nothing has been guessed.'
                  : `${found.found} of ${found.total} fields were detected by the service. Fields it did not find are shown as “Not found” and are never filled in.`}
              </p>
              {groups.map((g) => (
                <section key={g.title} aria-label={g.title}>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-muted">{g.title}</h3>
                  <dl className="mt-1 divide-y divide-line rounded-lg border border-line text-sm">
                    {g.rows.map((f) => (
                      <div key={f.key} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                        <dt className="text-muted">{f.label}</dt>
                        <dd className={cx('text-right', !f.found && 'text-muted')}>
                          {f.found ? (
                            <>
                              <span className="font-medium">{f.value}</span>
                              {f.normalized && <span className="ml-2 text-xs text-muted">({f.normalized})</span>}
                              <span className={cx('ml-2 text-xs', isLowConfidence(f.confidence) ? 'text-warning' : 'text-muted')}>
                                {[confidenceLabel(f.confidence), f.pageNumber ? `page ${f.pageNumber}` : ''].filter(Boolean).join(' · ')}
                              </span>
                            </>
                          ) : (
                            'Not found'
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
              {ocr.lineItems?.length > 0 && (
                <section aria-label="Detected line items">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Line items the service detected ({ocr.lineItems.length})</h3>
                  <ul className="mt-1 divide-y divide-line rounded-lg border border-line text-xs">
                    {ocr.lineItems.map((li, i) => (
                      <li key={i} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                        <span className="font-medium">{li.description?.value || li.text}</span>
                        <span className="text-muted">
                          {[li.quantity && `qty ${li.quantity.value}`, li.unitPrice && `rate ${li.unitPrice.value}`, li.amount && `amount ${li.amount.value}`]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      {aiFailure && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {aiFailure}
        </p>
      )}
      {!hasExtraction && ai && !ai.configured && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-subtle px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> AI extraction isn’t set up yet. {ai.setup}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back to uploads
        </Button>
        <Button variant="secondary" onClick={onContinue} disabled={busy}>
          Enter details manually
        </Button>
        {hasExtraction ? (
          <Button variant="accent" onClick={onViewExtraction} disabled={busy}>
            View extracted invoice
          </Button>
        ) : (
          <Button variant="accent" onClick={onExtract} loading={busy} disabled={busy || !ai?.configured}>
            <Sparkles className="h-4 w-4" /> {aiFailure ? 'Retry extraction' : 'Extract Invoice with AI'}
          </Button>
        )}
      </div>
    </div>
  );
}
