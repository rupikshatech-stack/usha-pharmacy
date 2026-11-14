import { Fragment, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, Plus, Trash2, XCircle } from 'lucide-react';
import { ITEM_COLUMNS, ITEM_MORE, SECTIONS, TONE_CLASS, TOTAL_FIELDS, blankItem, fieldState, issueCounts, issuesForLine } from '../../utils/extraction';
import { inr } from '../../utils/format';
import { Badge, Button, cx, inputCls } from '../common/ui';

const SEVERITY = {
  error: { tone: 'danger', Icon: XCircle, label: 'Error' },
  warning: { tone: 'warning', Icon: AlertTriangle, label: 'Warning' },
  info: { tone: 'info', Icon: Info, label: 'Note' },
};

/** One input, outlined by what is known about its value: an issue on it, low confidence, not found, or edited by a person. */
function Cell({ path, value, onChange, ex, errors, label, numeric, className }) {
  const st = fieldState(ex.meta, ex.issueMap, path);
  const bad = errors[path];
  return (
    <input
      aria-label={label}
      aria-invalid={bad ? true : undefined}
      title={bad || st.tip || undefined}
      value={value}
      inputMode={numeric ? 'decimal' : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={cx(inputCls, 'h-9 text-sm', numeric && 'text-right tabular-nums', st.tone && TONE_CLASS[st.tone], bad && 'border-danger', className)}
    />
  );
}

/**
 * The AI-extracted invoice as an editable, structured form: supplier, invoice, medicine table, totals — each value outlined by how far it can be trusted
 * (issues, low OCR confidence, not found in the OCR text, edited by a person), with the backend's checks listed and its re-calculated totals shown
 * beside what the invoice says. It edits text in memory; the page saves, validates and reviews. Nothing here is verified by being shown.
 */
export default function InvoiceExtractionEditor({ ex, form, setForm, errors }) {
  const [open, setOpen] = useState({});
  const issues = ex.validation?.issues || [];
  const counts = issueCounts(issues);
  const setField = (section, key, v) => setForm((f) => ({ ...f, [section]: { ...f[section], [key]: v } }));
  const setItem = (i, key, v) => setForm((f) => ({ ...f, items: f.items.map((it, n) => (n === i ? { ...it, [key]: v } : it)) }));
  const computed = ex.validation?.computed;
  // what cannot be saved yet, as readable lines (a table cell only has room for a tooltip)
  const toFix = Object.entries(errors).map(([path, message]) => {
    const [part, i, field] = path.split('.');
    const label =
      part === 'items'
        ? `Line ${Number(i) + 1} ${([...ITEM_COLUMNS, ...ITEM_MORE].find(([k]) => k === field) || [field, field])[1]}`
        : part === 'totals'
          ? (TOTAL_FIELDS.find(([k]) => k === i) || [i, i])[1]
          : ((SECTIONS.find((x) => x.key === part)?.fields || []).find(([k]) => k === i) || [i, i])[1];
    return `${label}: ${message}`;
  });

  return (
    <div className="space-y-5">
      {toFix.length > 0 && (
        <ul role="alert" aria-label="Values to fix" className="space-y-0.5 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {toFix.map((m, n) => (
            <li key={n}>{m}</li>
          ))}
        </ul>
      )}
      {ex.duplicates?.length > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <div>
            <p className="font-semibold text-danger">Possible duplicate invoice</p>
            <p className="mt-0.5">This supplier’s invoice number already exists:</p>
            <ul className="mt-1 list-disc pl-5">
              {ex.duplicates.map((d) => (
                <li key={`${d.type}-${d.id}`}>
                  {d.type === 'order' ? 'Order' : 'Upload'} <b>{d.reference}</b> ({d.status}){d.fileName ? ` — ${d.fileName}` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {ex.stale && (
        <p role="status" className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          The OCR text was read again after this extraction was made. Re-extract to use the newer text.
        </p>
      )}

      {/* ---- supplier and invoice ---- */}
      {SECTIONS.map((s) => (
        <section key={s.key} aria-label={s.title} className="space-y-2">
          <h3 className="text-sm font-bold">{s.title}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.fields.map(([k, label, kind]) => (
              <label key={k} className={cx('block text-xs font-semibold text-muted', k === 'address' && 'sm:col-span-2')}>
                {label}
                <Cell
                  path={`${s.key}.${k}`}
                  value={form[s.key][k]}
                  onChange={(v) => setField(s.key, k, v)}
                  ex={ex}
                  errors={errors}
                  label={label}
                  numeric={false}
                  className={cx('mt-1 font-normal text-ink', kind === 'date' && 'tabular-nums')}
                />
                {errors[`${s.key}.${k}`] && <span className="mt-0.5 block font-normal text-danger">{errors[`${s.key}.${k}`]}</span>}
              </label>
            ))}
          </div>
        </section>
      ))}

      {/* ---- medicines ---- */}
      <section aria-label="Medicines" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">
            Medicines{' '}
            <span className="font-normal text-muted">
              ({form.items.length} row{form.items.length === 1 ? '' : 's'}, exactly as read)
            </span>
          </h3>
          <Button size="sm" variant="secondary" onClick={() => setForm((f) => ({ ...f, items: [...f.items, blankItem()] }))}>
            <Plus className="h-4 w-4" /> Add row
          </Button>
        </div>
        {form.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">No medicine rows were found. Add them by hand while looking at the document.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-max min-w-full border-collapse text-left text-xs">
              <thead className="bg-subtle">
                <tr>
                  <th className="px-2 py-2">#</th>
                  {ITEM_COLUMNS.map(([k, label]) => (
                    <th key={k} scope="col" className="px-1.5 py-2 font-semibold">
                      {label}
                    </th>
                  ))}
                  <th className="px-2 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {form.items.map((it, i) => {
                  const lineIssues = issuesForLine(issues, i);
                  const row = fieldState(ex.meta, ex.issueMap, `items.${i}.row`);
                  const expanded = open[i];
                  return (
                    <Fragment key={i}>
                      <tr className="border-t border-line align-top">
                        <td className="px-2 py-1.5 text-muted">
                          <button
                            type="button"
                            aria-label={`${expanded ? 'Hide' : 'Show'} more details of line ${i + 1}`}
                            aria-expanded={Boolean(expanded)}
                            onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
                            className="flex items-center gap-1"
                          >
                            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} {i + 1}
                          </button>
                        </td>
                        {ITEM_COLUMNS.map(([k, label, kind, w]) => (
                          <td key={k} className="px-1 py-1">
                            <Cell
                              path={`items.${i}.${k}`}
                              value={it[k]}
                              onChange={(v) => setItem(i, k, v)}
                              ex={ex}
                              errors={errors}
                              label={`${label} of line ${i + 1}`}
                              numeric={['number', 'percent'].includes(kind)}
                              className={w}
                            />
                          </td>
                        ))}
                        <td className="px-1 py-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove line ${i + 1}`}
                            onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, n) => n !== i) }))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                      {(lineIssues.length > 0 || row.tone === 'warning' || expanded) && (
                        <tr className="bg-subtle/50">
                          <td />
                          <td colSpan={ITEM_COLUMNS.length + 1} className="px-2 py-2">
                            {lineIssues.length > 0 && (
                              <ul aria-label={`Issues on line ${i + 1}`} className="mb-2 space-y-0.5">
                                {lineIssues.map((x, n) => (
                                  <li
                                    key={n}
                                    className={cx('flex items-start gap-1.5', x.severity === 'error' ? 'text-danger' : x.severity === 'warning' ? 'text-warning' : 'text-muted')}
                                  >
                                    {(() => {
                                      const S = SEVERITY[x.severity].Icon;
                                      return <S className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
                                    })()}{' '}
                                    {x.message}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {expanded && (
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {ITEM_MORE.map(([k, label, kind]) => (
                                  <label key={k} className="block text-xs font-semibold text-muted">
                                    {label}
                                    <Cell
                                      path={`items.${i}.${k}`}
                                      value={it[k]}
                                      onChange={(v) => setItem(i, k, v)}
                                      ex={ex}
                                      errors={errors}
                                      label={`${label} of line ${i + 1}`}
                                      numeric={['number', 'percent', 'page'].includes(kind)}
                                      className="mt-1 font-normal text-ink"
                                    />
                                  </label>
                                ))}
                                {it.sourceText && <p className="text-muted sm:col-span-2 lg:col-span-3">OCR text of this row: {it.sourceText}</p>}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- totals ---- */}
      <section aria-label="Totals" className="space-y-2">
        <h3 className="text-sm font-bold">Invoice totals</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TOTAL_FIELDS.map(([k, label, kind]) => (
            <label key={k} className={cx('block text-xs font-semibold text-muted', k === 'amountInWords' && 'sm:col-span-2')}>
              {label}
              <Cell
                path={`totals.${k}`}
                value={form.totals[k]}
                onChange={(v) => setField('totals', k, v)}
                ex={ex}
                errors={errors}
                label={label}
                numeric={kind !== 'text'}
                className="mt-1 font-normal text-ink"
              />
              {errors[`totals.${k}`] && <span className="mt-0.5 block font-normal text-danger">{errors[`totals.${k}`]}</span>}
            </label>
          ))}
        </div>
        {computed && (
          <dl aria-label="Calculated by the system" className="grid gap-x-6 gap-y-1 rounded-xl bg-subtle p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="col-span-full text-muted">Calculated by the system from the lines above (the invoice’s own figures are never changed):</div>
            {[
              ['Lines taxable', computed.sums.taxable],
              ['Lines tax', computed.sums.tax],
              ['Lines total', computed.sums.lineTotal],
              ['Grand total', computed.grandTotal],
            ].map(([l, v]) => (
              <div key={l} className="flex justify-between gap-2">
                <dt className="text-muted">{l}</dt>
                <dd className="font-semibold tabular-nums">{v == null ? '—' : inr(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* ---- checks ---- */}
      <section aria-label="Validation results" className="space-y-2">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold">
          Checks
          <Badge tone={counts.error ? 'danger' : 'success'}>
            {counts.error} error{counts.error === 1 ? '' : 's'}
          </Badge>
          <Badge tone={counts.warning ? 'warning' : 'neutral'}>
            {counts.warning} warning{counts.warning === 1 ? '' : 's'}
          </Badge>
        </h3>
        {issues.length === 0 ? (
          <p className="text-sm text-muted">
            The figures are consistent and every value was found in the OCR text. This is still software’s reading: check it against the document before relying on it.
          </p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-auto rounded-xl border border-line p-3 text-sm">
            {issues.map((x, n) => {
              const { Icon } = SEVERITY[x.severity];
              return (
                <li key={n} className={cx('flex items-start gap-2', x.severity === 'error' ? 'text-danger' : x.severity === 'warning' ? 'text-warning' : 'text-muted')}>
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="text-ink">
                    {x.message}
                    {x.difference != null && <span className="ml-1 text-xs text-muted">(difference {inr(Math.abs(x.difference))})</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {ex.aiWarnings?.length > 0 && (
          <div className="rounded-xl bg-subtle p-3 text-xs">
            <p className="font-semibold">Notes from the reading</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {ex.aiWarnings.map((w, n) => (
                <li key={n}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
