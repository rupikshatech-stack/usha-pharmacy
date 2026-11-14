import { useState } from 'react';
import { Download } from 'lucide-react';
import { errorReportCsv, rowTabs } from '../../utils/importFile';
import { downloadText } from '../../utils/download';
import { Button, Pagination, StatusBadge, cx } from '../common/ui';

const PAGE = 20;
const ACTION = { create_medicine_with_batch: 'New medicine + batch', create_medicine: 'New medicine', add_batch: 'Add batch' };

/** Row-by-row results of an import: filter tabs, errors per row, and a download of the problem rows. */
export default function ImportRowsTable({ rows, fileLabel = 'import' }) {
  const [tab, setTab] = useState('all');
  const [page, setPage] = useState(1);
  const tabs = rowTabs(rows);
  const current = tabs.find((t) => t.key === tab) || tabs[0];
  const shown = rows.filter(current.match);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const slice = shown.slice((Math.min(page, pages) - 1) * PAGE, Math.min(page, pages) * PAGE);
  const problems = tabs[2].count;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <div role="tablist" aria-label="Filter rows" className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === current.key}
              onClick={() => {
                setTab(t.key);
                setPage(1);
              }}
              className={cx('rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors', t.key === current.key ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-subtle hover:text-ink')}
            >
              {t.label} <span className="tabular-nums opacity-70">{t.count}</span>
            </button>
          ))}
        </div>
        {problems > 0 && (
          <Button size="sm" variant="secondary" onClick={() => downloadText(`${fileLabel.replace(/\.csv$/i, '')}-errors.csv`, errorReportCsv(rows))}>
            <Download className="h-3.5 w-3.5" /> Download error report
          </Button>
        )}
      </div>

      <div className="max-h-[28rem] overflow-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-subtle text-[11px] uppercase tracking-wider text-muted">
            <tr>
              {['Row', 'Medicine', 'SKU / Barcode', 'Batch', 'Status', 'Details'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 py-2.5 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r) => (
              <tr key={r.row} className="border-t border-line align-top">
                <td className="px-4 py-2.5 tabular-nums text-muted">{r.row}</td>
                <td className="px-4 py-2.5 font-medium">{r.medicineName || <span className="text-muted">(blank)</span>}</td>
                <td className="px-4 py-2.5 text-xs text-muted">{[r.sku, r.barcode].filter(Boolean).join(' / ') || '—'}</td>
                <td className="px-4 py-2.5 font-mono text-[13px]">{r.batchNumber || <span className="font-sans text-muted">—</span>}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={r.status} />
                  {r.status === 'valid' && r.action && <div className="mt-0.5 text-[11px] text-muted">{ACTION[r.action]}</div>}
                </td>
                <td className="px-4 py-2.5">
                  {r.errors?.length > 0 ? (
                    <ul className="space-y-0.5 text-xs text-danger">
                      {r.errors.map((e, i) => (
                        <li key={i}>
                          <span className="font-semibold">{e.field}:</span> {e.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className={cx('text-xs', r.status === 'failed' ? 'text-danger' : 'text-muted')}>{r.message || '—'}</span>
                  )}
                </td>
              </tr>
            ))}
            {slice.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">No rows in this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {shown.length > PAGE && <Pagination page={Math.min(page, pages)} pages={pages} total={shown.length} limit={PAGE} onPage={setPage} />}
    </div>
  );
}
