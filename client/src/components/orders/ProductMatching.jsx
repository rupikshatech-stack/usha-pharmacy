import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Info, Loader2, RefreshCw, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { aiBillingService } from '../../services/aiBillingService';
import { expiryFmt } from '../../utils/format';
import { FILTERS, MAPPING_SOURCE_TEXT, STATUS_TEXT, STATUS_TONE, criticalConflicts, remaining, rowActions, scoreText, summaryCards } from '../../utils/productMatching';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Modal, SearchInput, Skeleton, cx } from '../common/ui';

const CARD_TONE = { success: 'text-success', warning: 'text-warning', danger: 'text-danger' };

/** One product suggestion: its master details, the similarity score and — when opened — why it matches and what conflicts. */
function Suggestion({ s, current, onSelect, busy, openReasons, toggle }) {
  const p = s.product;
  return (
    <li className={cx('rounded-xl border p-3 text-sm', current ? 'border-primary bg-primary/5' : 'border-line', s.verdict === 'conflict' && 'bg-danger/5')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">
            {p.name} {current && <Badge tone="info">Chosen</Badge>} {s.verdict === 'conflict' && <Badge tone="danger">Conflict</Badge>}
          </div>
          <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['SKU', p.sku],
              ['Brand', p.brand],
              ['Manufacturer', p.manufacturer],
              ['Strength', p.strength],
              ['Dosage form', p.dosageForm],
              ['Pack size', p.packSize],
              ['HSN', p.hsnCode],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt>{k}:</dt>
                <dd className="font-medium text-ink">{v || '—'}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted" title="How alike the attributes are. This is not a probability of being right.">
            Score <b className="text-ink">{scoreText(s.score)}</b>
          </span>
          <Button size="sm" variant="secondary" onClick={toggle} aria-expanded={openReasons} aria-label={`Why ${p.name}`}>
            Why
          </Button>
          <Button size="sm" variant="accent" onClick={onSelect} disabled={busy || current} aria-label={`Select ${p.name}`}>
            Select
          </Button>
        </div>
      </div>
      {openReasons && (
        <div className="mt-2 grid gap-2 border-t border-line pt-2 text-xs sm:grid-cols-2">
          <div>
            <p className="font-semibold text-success">Matching reasons</p>
            {s.reasons.length ? (
              <ul className="mt-0.5 space-y-0.5">
                {s.reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" /> {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None.</p>
            )}
          </div>
          <div>
            <p className="font-semibold text-warning">Conflicts and warnings</p>
            {s.conflicts.length ? (
              <ul className="mt-0.5 space-y-0.5">
                {s.conflicts.map((c, i) => (
                  <li key={i} className={cx('flex items-start gap-1', c.level === 'critical' ? 'text-danger' : 'text-warning')}>
                    {c.level === 'critical' ? (
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    )}{' '}
                    {c.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None.</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** The search dialog: any product of the existing catalog, found by name, SKU, barcode, manufacturer, brand or strength. */
function ProductPickerDialog({ upload, row, onClose, onSelect, busy }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const t = setTimeout(
      async () => {
        try {
          setErr('');
          setRes(await aiBillingService.suggestions(upload._id, row.itemId, q.trim()));
        } catch (e) {
          setErr(e.message);
        }
      },
      q ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [q, upload._id, row.itemId]);
  return (
    <Modal title={`Select product for “${row.invoice.name}”`} description="Search the existing products. Nothing is created here." onClose={onClose} wide>
      <div className="space-y-3">
        <SearchInput value={q} onChange={setQ} placeholder="Name, SKU, barcode, manufacturer, brand or strength" label="Search products" autoFocus />
        {err && <ErrorState message={err} />}
        {!res && !err && <Skeleton className="h-20 w-full" />}
        {res && res.none && (
          <div className="rounded-xl border border-dashed border-line p-4 text-sm">
            <p className="font-semibold">No matching product found.</p>
            <p className="mt-1 text-muted">{res.createProductHint || 'Try another word.'}</p>
            <a href="/inventory" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              Open Inventory to add the product <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        )}
        {res && !res.none && (
          <ul aria-label="Products" className="max-h-[26rem] space-y-2 overflow-auto">
            {res.suggestions.map((s) => (
              <Suggestion
                key={s.productId}
                s={s}
                current={String(row.product?._id) === s.productId}
                busy={busy}
                onSelect={() => onSelect(s.productId)}
                openReasons={open === s.productId}
                toggle={() => setOpen(open === s.productId ? null : s.productId)}
              />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/**
 * MEDICINE PRODUCT MATCHING: each medicine read from the invoice, the existing product it probably is, why, and what a person decided. The server decides
 * what is "Matched / Needs Review / Unmatched"; nothing here confirms a match by itself, creates a product, or changes stock. Rows keep their own batch,
 * expiry and quantity from the invoice.
 */
export default function ProductMatching({ upload, onBack, onContinue, onProceed }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState({}); // rows whose suggestions are showing
  const [why, setWhy] = useState(null); // "itemId:productId" whose reasons are showing
  const [picking, setPicking] = useState(null);
  const [ask, setAsk] = useState(null); // a conflict that needs an explicit "yes"
  const [busy, setBusy] = useState('');
  const id = upload._id;

  const loading = useRef(false);
  const load = useCallback(async () => {
    if (loading.current) return; // one load at a time (React runs effects twice in development, and a double click must not race either)
    loading.current = true;
    try {
      setError('');
      let m = await aiBillingService.productMatches(id);
      if (!m.matched) {
        try {
          m = await aiBillingService.matchProducts(id);
        } catch (e) {
          if (e.code !== 'MATCH_CHANGED') throw e;
          m = await aiBillingService.productMatches(id); // someone else matched at the same moment: show their result
        }
      }
      setData(m);
    } catch (e) {
      setError(e.message);
    } finally {
      loading.current = false;
    }
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the matches are loaded (and made the first time) when the screen opens
    load();
  }, [load]);

  const run = async (key, fn, ok, retry) => {
    setBusy(key);
    try {
      const r = await fn();
      setData((d) => ({ ...d, ...r }));
      if (ok) toast.success(ok(r));
      return r;
    } catch (e) {
      if (e.code === 'MATCH_CONFLICT' && retry) setAsk({ conflicts: e.details || [], message: e.message, retry });
      else toast.error(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const matchAgain = () =>
    run(
      'match',
      () => aiBillingService.matchProducts(id),
      () => 'Products matched again. Confirmed rows were kept.',
    );
  const select = (row, productId, acknowledgeConflicts = false) =>
    run(
      `select:${row.itemId}`,
      () => aiBillingService.selectProduct(id, row.itemId, { productId, acknowledgeConflicts }),
      () => 'Product chosen. Confirm it to make it final.',
      () => select(row, productId, true),
    ).then((r) => {
      if (r) setPicking(null);
      return r;
    });
  const confirm = (row, acknowledgeConflicts = false) =>
    run(
      `confirm:${row.itemId}`,
      () => aiBillingService.confirmMatch(id, row.itemId, { acknowledgeConflicts }),
      () => 'Match confirmed. Nothing was added to stock.',
      () => confirm(row, true),
    );
  const unmatched = (row) =>
    run(
      `unmatched:${row.itemId}`,
      () => aiBillingService.markUnmatched(id, row.itemId),
      () => 'Marked as having no matching product.',
    );
  const confirmAll = () =>
    run(
      'all',
      () => aiBillingService.confirmAllMatches(id),
      (r) => `${r.confirmed} match${r.confirmed === 1 ? '' : 'es'} confirmed${r.skipped?.length ? `; ${r.skipped.length} left for you to check` : ''}.`,
    );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items || []).filter(
      (r) => (!filter || r.status === filter) && (!q || r.invoice.name.toLowerCase().includes(q) || (r.product?.name || '').toLowerCase().includes(q)),
    );
  }, [data, filter, search]);

  if (error)
    return (
      <div className="border-t border-line p-4 sm:p-5">
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  if (!data) {
    return (
      <div className="space-y-3 border-t border-line p-4 sm:p-5" aria-live="polite">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Matching the medicines with your products…
        </p>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const cards = summaryCards(data.summary);
  const left = remaining(data.summary);
  return (
    <div className="space-y-4 border-t border-line p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
            Medicine Product Matching {data.readyForPhase5 && <Badge tone="success">All products confirmed</Badge>}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {upload.uploadId} · matched {data.runAt ? new Date(data.runAt).toLocaleString('en-IN') : ''} · thresholds: matched ≥ {Math.round(data.config.auto * 100)}%, review ≥{' '}
            {Math.round(data.config.review * 100)}%
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={matchAgain} loading={busy === 'match'} disabled={Boolean(busy)}>
            <RefreshCw className="h-4 w-4" /> Match again
          </Button>
          <Button variant="accent" onClick={confirmAll} loading={busy === 'all'} disabled={Boolean(busy) || left === 0}>
            Confirm all eligible
          </Button>
        </div>
      </div>

      <div role="status" className="flex items-start gap-3 rounded-xl bg-subtle p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        <p>
          Suggestions are not decisions. A different strength, dosage form or active ingredient is never matched automatically. “Matched” means no conflict was found; a person
          still confirms each row. No product is created and no stock changes here.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Matching summary">
        {cards.map((c) => (
          <Card key={c.key} className="p-4">
            <div className="text-sm font-medium text-muted">{c.label}</div>
            <div className={cx('mt-1 text-[26px] font-extrabold tabular-nums', CARD_TONE[c.tone])} data-testid={`card-${c.key}`}>
              {c.value}
            </div>
            <div className="text-xs text-muted">{c.hint}</div>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
          {FILTERS.map(([v, label]) => (
            <button
              key={v || 'all'}
              type="button"
              aria-pressed={filter === v}
              onClick={() => setFilter(v)}
              className={cx(
                'rounded-full border px-3 py-1 text-xs font-semibold',
                filter === v ? 'border-primary bg-primary/10 text-primary' : 'border-line text-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="Search medicine names" label="Search invoice medicines" className="w-full sm:ml-auto sm:w-72" />
      </div>

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[68rem] border-collapse text-left text-xs">
          <thead className="bg-subtle">
            <tr>
              {[
                '#',
                'Invoice Medicine Name',
                'Invoice Manufacturer',
                'Strength',
                'Dosage Form',
                'Batch Number',
                'Expiry Date',
                'Invoice Quantity',
                'Suggested Existing Product',
                'Matching Status',
                'Actions',
              ].map((h) => (
                <th key={h} scope="col" className="px-2.5 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-muted">
                  No rows match this filter.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const a = rowActions(r);
              const expanded = open[r.itemId];
              const crit = criticalConflicts(r.conflicts);
              return (
                <Fragment key={r.itemId || r.index}>
                  <tr className="border-t border-line align-top">
                    <td className="px-2.5 py-2 text-muted">{r.index + 1}</td>
                    <td className="px-2.5 py-2 font-medium">{r.invoice.name || '—'}</td>
                    <td className="px-2.5 py-2">{r.invoice.manufacturer || '—'}</td>
                    <td className="px-2.5 py-2">{r.invoice.strength || '—'}</td>
                    <td className="px-2.5 py-2 capitalize">{r.invoice.dosageForm || '—'}</td>
                    <td className="px-2.5 py-2">{r.invoice.batchNumber || '—'}</td>
                    <td className="px-2.5 py-2">{r.invoice.expiryDate ? expiryFmt(r.invoice.expiryDate) : '—'}</td>
                    <td className="px-2.5 py-2 tabular-nums">
                      {r.invoice.quantity ?? '—'}
                      {r.invoice.freeQuantity ? ` + ${r.invoice.freeQuantity} free` : ''}
                    </td>
                    <td className="px-2.5 py-2">
                      {r.product ? (
                        <>
                          <div className="font-medium">{r.product.name}</div>
                          <div className="text-muted">{[r.product.sku, r.product.manufacturer].filter(Boolean).join(' · ')}</div>
                          {r.mappingSource && <div className="text-muted">{MAPPING_SOURCE_TEXT[r.mappingSource]}</div>}
                        </>
                      ) : (
                        <span className="text-muted">{r.notMatchedYet ? 'Not matched yet' : 'No product'}</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={STATUS_TONE[r.status]} dot>
                          {STATUS_TEXT[r.status]}
                        </Badge>
                        {r.confirmation === 'confirmed' && <Badge tone="sage">Confirmed</Badge>}
                        {r.confirmation === 'unmatched' && <Badge tone="neutral">Marked unmatched</Badge>}
                        {r.stale && <Badge tone="warning">Edited</Badge>}
                        {r.score != null && r.product && <span className="text-muted">Score {scoreText(r.score)}</span>}
                      </div>
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="flex flex-wrap gap-1">
                        {a.viewSuggestions && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-expanded={Boolean(expanded)}
                            aria-label={`View suggestions for ${r.invoice.name}`}
                            onClick={() => setOpen((o) => ({ ...o, [r.itemId]: !o[r.itemId] }))}
                          >
                            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} View Suggestions
                          </Button>
                        )}
                        <Button size="sm" variant="secondary" aria-label={`${a.selectLabel} for ${r.invoice.name}`} onClick={() => setPicking(r)} disabled={Boolean(busy)}>
                          {a.selectLabel}
                        </Button>
                        {a.confirm && (
                          <Button
                            size="sm"
                            variant="accent"
                            aria-label={`Confirm match for ${r.invoice.name}`}
                            onClick={() => confirm(r)}
                            loading={busy === `confirm:${r.itemId}`}
                            disabled={Boolean(busy)}
                          >
                            Confirm Match
                          </Button>
                        )}
                        {a.markUnmatched && (
                          <Button size="sm" variant="ghost" aria-label={`Mark ${r.invoice.name} as unmatched`} onClick={() => unmatched(r)} disabled={Boolean(busy)}>
                            Mark as Unmatched
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {(expanded || r.warnings.length > 0 || crit.length > 0) && (
                    <tr className="bg-subtle/50">
                      <td />
                      <td colSpan={10} className="px-2.5 py-2">
                        {r.warnings.length > 0 && (
                          <ul aria-label={`Warnings for ${r.invoice.name}`} className="mb-2 space-y-0.5 text-warning">
                            {r.warnings.map((w, i) => (
                              <li key={i} className="flex items-start gap-1.5">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {w}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.reasons.length > 0 && r.product && (
                          <p className="mb-2 text-muted">
                            <b className="text-ink">Why this product:</b> {r.reasons.join('; ')}.
                          </p>
                        )}
                        {expanded &&
                          (r.suggestions.length === 0 ? (
                            <p className="text-muted">No suggestions. Use “{a.selectLabel}” to search the products. If it does not exist, add it in Inventory.</p>
                          ) : (
                            <ul aria-label={`Suggestions for ${r.invoice.name}`} className="space-y-2">
                              {r.suggestions.map((s) => (
                                <Suggestion
                                  key={s.productId}
                                  s={s}
                                  current={String(r.product?._id) === s.productId}
                                  busy={Boolean(busy)}
                                  onSelect={() => select(r, s.productId)}
                                  openReasons={why === `${r.itemId}:${s.productId}`}
                                  toggle={() => setWhy(why === `${r.itemId}:${s.productId}` ? null : `${r.itemId}:${s.productId}`)}
                                />
                              ))}
                            </ul>
                          ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        <p className="text-sm text-muted" role="status">
          {left === 0 ? 'Every row is decided.' : `${left} row${left === 1 ? '' : 's'} still to confirm.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onBack} disabled={Boolean(busy)}>
            Back to extracted invoice
          </Button>
          <Button variant="secondary" onClick={() => onContinue(data)} disabled={Boolean(busy)}>
            Continue to draft review
          </Button>
          {onProceed && (
            <Button
              variant="accent"
              onClick={() => onProceed(data)}
              disabled={Boolean(busy) || !data.readyForPhase5}
              title={data.readyForPhase5 ? undefined : 'Confirm a product for every row first'}
            >
              Proceed to Goods Receipt
            </Button>
          )}
        </div>
      </div>

      {picking && <ProductPickerDialog upload={upload} row={picking} onClose={() => setPicking(null)} onSelect={(pid) => select(picking, pid)} busy={Boolean(busy)} />}
      {ask && (
        <ConfirmDialog
          title="This product conflicts with the invoice"
          message={`${ask.message} Only continue if the invoice line is wrong or you are certain it is the same product.`}
          confirmLabel="Use it anyway"
          danger
          onConfirm={async () => {
            const again = ask.retry;
            setAsk(null);
            await again();
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </div>
  );
}
