import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Download, FileSpreadsheet, History, Loader2, Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { importService } from '../../services/importService';
import { useFetch } from '../../hooks/useFetch';
import { dateTimeFmt } from '../../utils/format';
import { checkFile, confirmLabel, formatBytes } from '../../utils/importFile';
import { downloadText } from '../../utils/download';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, PageHeader, Pagination, Skeleton, StatusBadge, cx } from '../../components/common/ui';
import ImportRowsTable from '../../components/inventory/ImportRowsTable';
import ImportSummary from '../../components/inventory/ImportSummary';
import ImportDetails from '../../components/inventory/ImportDetails';

const STEPS = ['Upload', 'Review', 'Done'];

function Steps({ current }) {
  return (
    <ol className="mb-5 flex items-center gap-2 text-sm" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === current ? 'step' : undefined}>
          <span className={cx('grid h-6 w-6 place-items-center rounded-full text-xs font-bold', i <= current ? 'bg-primary text-white' : 'bg-subtle text-muted')}>{i < current ? '✓' : i + 1}</span>
          <span className={cx('font-semibold', i === current ? 'text-ink' : 'text-muted')}>{s}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-8 bg-line" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

/**
 * Import Inventory (CSV). Upload -> the server validates every row and shows a preview -> confirm -> summary.
 * Nothing is written until the user confirms, and the confirm step re-checks everything on the server.
 */
export default function Import() {
  const [stage, setStage] = useState('upload'); // upload | review | done
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [historyPage, setHistoryPage] = useState(1);
  const input = useRef(null);
  const history = useFetch('/import/inventory/history', { page: historyPage, limit: 5 });

  const pick = (f) => {
    const problem = checkFile(f);
    setFileError(problem);
    setFile(problem ? null : f);
  };

  const downloadTemplate = async () => {
    try {
      const t = await importService.template();
      downloadText(t.fileName, t.csv);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const upload = async () => {
    setBusy(true);
    setFileError('');
    try {
      const text = await file.text();
      setJob(await importService.preview(file.name, text));
      setStage('review');
    } catch (e) {
      setFileError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const done = await importService.confirm(job._id, true);
      setJob(done);
      setStage('done');
      history.reload();
      const s = done.summary;
      if (s.failed) toast.error(`${s.imported} imported, ${s.failed} failed and were rolled back`);
      else toast.success(`${s.imported} row${s.imported === 1 ? '' : 's'} imported`);
    } catch (e) {
      if (e.code === 'IMPORT_NOT_PENDING' || e.code === 'IMPORT_EXPIRED') {
        toast.error(e.message);
        reset();
      } else toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStage('upload');
    setFile(null);
    setJob(null);
    setFileError('');
    if (input.current) input.current.value = '';
  };

  const discard = async () => {
    setBusy(true);
    try {
      if (job?.status === 'previewed') await importService.cancel(job._id);
    } catch {
      /* already gone; nothing to undo */
    } finally {
      setBusy(false);
      setDiscarding(false);
      reset();
      history.reload();
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.[0]) pick(e.dataTransfer.files[0]);
  };

  return (
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6">
      <PageHeader
        title="Import Inventory"
        description="Add medicines and batches in bulk from a CSV file."
        actions={
          <Button variant="secondary" onClick={downloadTemplate}>
            <Download className="h-4 w-4" /> Download sample CSV
          </Button>
        }
      />
      <Steps current={stage === 'upload' ? 0 : stage === 'review' ? 1 : 2} />

      {stage === 'upload' && (
        <Card className="p-5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cx('flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors', dragging ? 'border-primary bg-primary/5' : 'border-line')}
          >
            <FileSpreadsheet className="h-10 w-10 text-muted" aria-hidden="true" />
            {file ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-sm">
                <span className="font-semibold">{file.name}</span>
                <span className="text-muted">{formatBytes(file.size)}</span>
                <button type="button" aria-label="Remove the selected file" onClick={reset} className="grid h-5 w-5 place-items-center rounded text-muted hover:text-danger">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <p className="mt-3 text-sm font-semibold">Drag a CSV file here</p>
                <p className="text-xs text-muted">or</p>
              </>
            )}
            <input ref={input} id="csv-file" aria-label="Choose a CSV file to import" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={() => input.current?.click()}>
                <Upload className="h-4 w-4" /> {file ? 'Choose a different file' : 'Choose CSV file'}
              </Button>
              {file && (
                <Button onClick={upload} loading={busy}>
                  Check file
                </Button>
              )}
            </div>
            {fileError && <p role="alert" className="mt-3 max-w-xl text-sm text-danger">{fileError}</p>}
            <p className="mt-4 text-xs text-muted">CSV only, up to 2 MB and 2,000 rows. Nothing is imported until you confirm.</p>
          </div>

          <div className="mt-5 grid gap-4 text-sm text-muted sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-[13px] font-bold text-ink">How the file works</h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>One row per batch. Repeat the medicine on each row to add several batches.</li>
                <li>A row without batch columns just creates the medicine.</li>
                <li>Only <b>medicineName</b> is always required. With a batch, also give batchNumber, expiryDate, mrp, sellingPrice and quantity.</li>
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-[13px] font-bold text-ink">What is checked</h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>GST between 0 and 100, HSN with 4–8 digits, real dates (YYYY-MM-DD or DD/MM/YYYY), expiry in the future.</li>
                <li>Duplicate SKUs, barcodes and batches — in the file and in your inventory.</li>
                <li>Medicines and batches that already exist are skipped, never changed or doubled.</li>
              </ul>
            </div>
          </div>
        </Card>
      )}

      {stage === 'review' && job && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <FileSpreadsheet className="h-4 w-4 text-muted" aria-hidden="true" />
            <span className="font-semibold">{job.fileName}</span>
            <span className="text-muted">{formatBytes(job.fileSize)}</span>
          </div>
          {job.warnings?.map((w) => (
            <p key={w} role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">{w}</p>
          ))}
          <ImportSummary summary={job.summary} finished={false} />
          <Card>
            <ImportRowsTable rows={job.rows} fileLabel={job.fileName} />
          </Card>
          {job.summary.invalid > 0 && (
            <p role="status" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {job.summary.invalid} row{job.summary.invalid === 1 ? ' has' : 's have'} errors and will <b>not</b> be imported. Fix them in your file and upload again, or import the valid rows now.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => setDiscarding(true)} disabled={busy}>
              Discard
            </Button>
            <Button onClick={confirm} loading={busy} disabled={job.summary.valid === 0}>
              {confirmLabel(job.summary)}
            </Button>
          </div>
        </div>
      )}

      {stage === 'done' && job && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-line bg-card p-4">
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <CheckCircle2 className={cx('h-6 w-6 shrink-0', job.status === 'completed' ? 'text-success' : 'text-warning')} aria-hidden="true" />}
            <div>
              <h2 className="text-base font-bold">{job.status === 'completed' ? 'Import complete' : job.status === 'failed' ? 'Import stopped' : 'Import finished with some problems'}</h2>
              <p className="text-sm text-muted">
                {job.medicinesCreated} new medicine{job.medicinesCreated === 1 ? '' : 's'} and {job.batchesCreated} new batch{job.batchesCreated === 1 ? '' : 'es'} were created.
                {job.summary.failed > 0 && ' Rows marked “Failed” were rolled back — nothing from them was saved.'}
                {job.error && ` ${job.error}`}
              </p>
            </div>
          </div>
          <ImportSummary summary={job.summary} finished />
          <Card>
            <ImportRowsTable rows={job.rows} fileLabel={job.fileName} />
          </Card>
          <div className="flex flex-wrap justify-end gap-2">
            <Link to="/inventory">
              <Button variant="secondary">View inventory</Button>
            </Link>
            <Button onClick={reset}>Import another file</Button>
          </div>
        </div>
      )}

      {/* History */}
      <section className="mt-8" aria-label="Import history">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
          <History className="h-4 w-4" aria-hidden="true" /> Import history
        </h2>
        <Card>
          {history.error ? (
            <ErrorState message={history.error} onRetry={history.reload} />
          ) : !history.data ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-3/4" />
            </div>
          ) : history.data.items.length === 0 ? (
            <EmptyState icon={History} title="No imports yet" hint="Your imports will be listed here, with what happened to every row." />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['When', 'File', 'By', 'Status', 'Rows', 'Imported', ''].map((h, i) => (
                        <th key={i} className="whitespace-nowrap px-4 py-2.5 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.items.map((j) => (
                      <tr key={j._id} className="border-t border-line">
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted">{dateTimeFmt(j.createdAt)}</td>
                        <td className="px-4 py-2.5 font-medium">{j.fileName}</td>
                        <td className="px-4 py-2.5 text-muted">{j.createdBy?.name || '—'}</td>
                        <td className="px-4 py-2.5"><StatusBadge status={j.status} /></td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {j.summary.total}
                          {j.summary.invalid > 0 && <Badge tone="danger">{j.summary.invalid} invalid</Badge>}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{j.summary.imported}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="ghost" onClick={() => setViewing(j._id)}>
                            View
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={history.data.page} pages={history.data.pages} total={history.data.total} limit={5} onPage={setHistoryPage} />
            </>
          )}
        </Card>
      </section>

      {viewing && <ImportDetails id={viewing} onClose={() => setViewing(null)} />}
      {discarding && (
        <ConfirmDialog danger title="Discard this import?" message="The file has been checked but nothing has been imported. Discarding it throws the preview away." confirmLabel="Discard" loading={busy} onConfirm={discard} onClose={() => setDiscarding(false)} />
      )}
    </div>
  );
}
