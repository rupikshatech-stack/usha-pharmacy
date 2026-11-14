import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, FileText, Image as ImageIcon, Info, Loader2, RefreshCw, Save, ScanLine, Trash2, Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { aiBillingService } from '../../services/aiBillingService';
import { orderService } from '../../services/orderService';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import { dateTimeFmt, newIdempotencyKey } from '../../utils/format';
import { SCAN_STATE_LABEL, scanState } from '../../utils/ocrView';
import { blankReview, fileProblem, fileSize, reviewFromDraft, reviewTotals, reviewedSnapshot, productFrom, toDraftOrderPayload, validateReview } from '../../utils/aiBilling';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Skeleton, cx } from '../../components/common/ui';
import DocumentPreview from '../../components/orders/DocumentPreview';
import InvoiceReview from '../../components/orders/InvoiceReview';
import OcrResults from '../../components/orders/OcrResults';
import InvoiceExtractionEditor from '../../components/orders/InvoiceExtractionEditor';
import ProductMatching from '../../components/orders/ProductMatching';
import FinalInvoiceReview from '../../components/orders/FinalInvoiceReview';
import GoodsReceiptForm from '../../components/orders/GoodsReceiptForm';
import { withConfirmedProducts } from '../../utils/productMatching';
import { STATE_TONE, formErrors, fromForm, isDirty, issueCounts, toForm, toReviewDraft } from '../../utils/extraction';
import NewSupplierDialog from '../../components/orders/NewSupplierDialog';

const STATUS_TONE = { uploaded: 'neutral', processing: 'info', completed: 'success', failed: 'danger', drafted: 'sage', discarded: 'neutral' };
const POLL_MS = 1500;

/** One step of the progress list. */
function Step({ state, label, detail }) {
  return (
    <li className="flex items-start gap-3 text-sm" aria-current={state === 'active' ? 'step' : undefined}>
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center">
        {state === 'done' ? (
          <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
        ) : state === 'active' ? (
          <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />
        ) : (
          <span className="h-3 w-3 rounded-full border-2 border-line" aria-hidden="true" />
        )}
      </span>
      <span className={cx(state === 'waiting' && 'text-muted')}>
        <span className="font-semibold">{label}</span>
        {detail && <span className="block text-xs text-muted">{detail}</span>}
      </span>
    </li>
  );
}

/**
 * AI Billing (Phase 1): upload a supplier invoice, scan it, review what was read, correct it, and save a DRAFT order.
 *
 * The invoice-reading service (OCR / AI) is chosen on the server and may be none: this screen never pretends otherwise. With none connected the file is
 * still stored and shown beside the review, so the details can be entered by hand against the document; with one connected the scan runs in the
 * background and the screen follows its status. Either way nothing is saved until the user has checked the review, and stock is never changed here.
 */
export default function AiBilling() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canUse = (user?.permissions || []).includes('inventory:write');
  const status = useFetch('/ai-billing/status');
  const recent = useFetch(canUse ? '/ai-billing/uploads' : '/ai-billing/status', canUse ? { limit: 5 } : undefined);
  const suppliers = useFetch('/suppliers', { limit: 100 });

  const [stage, setStage] = useState('upload'); // upload | processing | ocr | ai | extracted | matching | final | receipt | review
  const [ex, setEx] = useState(null); // the AI-extracted invoice (original, working copy, sources, checks)
  const [form, setForm] = useState(null); // the working copy as form text
  const [savedForm, setSavedForm] = useState(null);
  const [aiFailure, setAiFailure] = useState('');
  const [checkedByMe, setCheckedByMe] = useState(false);
  const [acceptIssues, setAcceptIssues] = useState(false);
  const [needAccept, setNeedAccept] = useState(false);
  const [exShow, setExShow] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [duplicate, setDuplicate] = useState(null);
  const [matches, setMatches] = useState(null); // the product matches last seen (confirmed rows pre-select their product in the draft review)
  const [ocr, setOcr] = useState(null); // the OCR results of the open upload (raw, unverified)
  const [file, setFile] = useState(null); // a File just chosen, or a Blob fetched from the server (for the preview)
  const [fileInfo, setFileInfo] = useState(null); // { name, size, type }
  const [fileError, setFileError] = useState('');
  const [upload, setUpload] = useState(null); // the server's record of the stored file
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState('upload'); // which step of the processing list is running
  const [seconds, setSeconds] = useState(0);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [r, setR] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [key] = useState(() => newIdempotencyKey());
  const input = useRef(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false; // React (in development) mounts, unmounts and mounts again: the flag must be reset on every mount
    return () => {
      cancelled.current = true;
    };
  }, []);

  const reset = () => {
    setFile(null);
    setFileInfo(null);
    setUpload(null);
    setFileError('');
    setFailure('');
    setNotice('');
    setProgress(0);
    setStage('upload');
    setR(null);
    setOcr(null);
    setEx(null);
    setForm(null);
    setMatches(null);
    setAiFailure('');
    setDuplicate(null);
    setConfirmed(false);
    setSubmitted(false);
    setServerError('');
    setParams({}, { replace: true });
  };

  const choose = (f) => {
    if (!f) return;
    const problem = fileProblem(f);
    setFileError(problem);
    setFailure('');
    setNotice('');
    if (problem) return;
    setUpload(null); // a different file is a different upload
    setOcr(null);
    setEx(null);
    setFile(f);
    setFileInfo({ name: f.name, size: f.size, type: f.type });
  };

  /** "Remove File": forget it here, and if it was already stored, remove it from the server too. */
  const removeFile = async () => {
    const stored = upload && ['uploaded', 'failed', 'completed'].includes(upload.status);
    setFile(null);
    setFileInfo(null);
    setFailure('');
    setNotice('');
    if (stored) {
      try {
        await aiBillingService.remove(upload._id);
        recent.reload();
      } catch (e) {
        toast.error(e.message);
      }
    }
    setUpload(null);
    setOcr(null);
  };

  const toReview = useCallback((u) => {
    setR(reviewFromDraft(u.extraction, 'ai'));
    setConfirmed(false);
    setSubmitted(false);
    setStage('review');
  }, []);

  /** Shows what OCR read. If the results cannot be fetched the person is told and can still go on to review by hand. */
  const showOcr = useCallback(async (u) => {
    try {
      setOcr(await aiBillingService.ocr(u._id));
      setStage('ocr');
    } catch (e) {
      toast.error(e.message);
      setStage('upload');
    }
  }, []);

  /** Shows the AI-extracted invoice for editing. */
  const loadExtraction = useCallback(async (id) => {
    const x = await aiBillingService.extracted(id);
    const f = toForm(x.current);
    setEx(x);
    setForm(f);
    setSavedForm(f);
    setCheckedByMe(false);
    setAcceptIssues(false);
    setNeedAccept(false);
    setExShow(false);
    setStage('extracted');
  }, []);

  /** Follows an AI extraction until it has finished or failed. */
  const followAi = useCallback(
    async (id) => {
      setStage('ai');
      for (let i = 0; i < 400 && !cancelled.current; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const s = await aiBillingService.extractionStatus(id);
        if (s.aiStatus !== 'processing') {
          setUpload(await aiBillingService.get(id));
          if (s.aiStatus === 'failed') {
            setAiFailure(s.error?.message || 'The AI could not read the invoice.');
            setStage('ocr');
            return undefined;
          }
          return loadExtraction(id);
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
      return undefined;
    },
    [loadExtraction],
  );

  /** Extract Invoice with AI (or Re-extract): the OCR text is read by the AI in the background and the screen follows it. */
  const extractWithAi = async (again = false) => {
    if (!upload || busy) return;
    setBusy(true);
    setAiFailure('');
    try {
      if (again) await aiBillingService.reprocessAi(upload._id);
      else await aiBillingService.aiExtract(upload._id);
      await followAi(upload._id);
    } catch (e) {
      if (e.code === 'AI_ALREADY_RUNNING') await followAi(upload._id);
      else if (e.code === 'AI_ALREADY_EXTRACTED') await loadExtraction(upload._id);
      else {
        setAiFailure(e.message);
        setStage('ocr');
      }
    } finally {
      setBusy(false);
    }
  };

  const exErrors = form ? formErrors(form) : {};
  const exDirty = form && savedForm ? isDirty(form, savedForm) : false;

  /** Saves the corrections (and, when asked, the person's review). Values that are not valid are never sent. */
  const persist = async ({ reviewed = false } = {}) => {
    setExShow(true);
    if (Object.keys(exErrors).length) {
      toast.error('Fix the highlighted values first.');
      return false;
    }
    if (!exDirty && !reviewed) return true;
    setBusy(true);
    try {
      const x = await aiBillingService.saveExtracted(upload._id, {
        data: fromForm(form),
        reviewed,
        confirmed: checkedByMe,
        acknowledgeIssues: acceptIssues,
        expectedEditCount: ex.editCount,
      });
      const f = toForm(x.current);
      setEx(x);
      setForm(f);
      setSavedForm(f);
      if (reviewed) toast.success('Marked as reviewed. Nothing has been saved as an order yet.');
      else toast.success('Changes saved.');
      return true;
    } catch (e) {
      if (e.code === 'REVIEW_ERRORS_REMAIN') setNeedAccept(true);
      toast.error(e.message);
      if (e.code === 'EXTRACTION_CHANGED') await loadExtraction(upload._id);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const validateNow = async () => {
    if (!(await persist())) return;
    setBusy(true);
    try {
      const x = await aiBillingService.validate(upload._id);
      setEx(x);
      const c = issueCounts(x.validation?.issues);
      toast(c.error + c.warning ? `${c.error} error(s) and ${c.warning} warning(s) found.` : 'No problems found. Check it against the document anyway.', {
        icon: c.error ? '⚠️' : '✅',
      });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Save as Draft: the corrected invoice goes to the order review (where products are chosen by a person — nothing is matched here). */
  const extractedToReview = async () => {
    if (!(await persist())) return;
    const cur = fromForm(form);
    setR(reviewFromDraft(withConfirmedProducts(toReviewDraft(cur, ex.validation?.issues), matches), 'ai'));
    setNotice(
      matches?.summary?.confirmed
        ? 'These details were extracted by AI from the OCR text and corrected by you. Products you confirmed are chosen; choose the rest and the supplier. Nothing here changes your stock.'
        : 'These details were extracted by AI from the OCR text and corrected by you. Products and the supplier are not matched automatically: choose each one. Nothing here changes your stock.',
    );
    setConfirmed(false);
    setSubmitted(false);
    setStage('review');
  };

  /** Match Products: saves any corrections first (the matching works from the saved invoice), then opens the product matching. */
  const openMatching = async () => {
    if (!(await persist())) return;
    setStage('matching');
  };

  /** From the product matching to the draft review: the rows keep their own batch, expiry and prices; confirmed products are chosen, the rest are left to the person. */
  const matchingToReview = (m) => {
    setMatches(m);
    setR(reviewFromDraft(withConfirmedProducts(toReviewDraft(fromForm(form), ex.validation?.issues), m), 'ai'));
    setNotice('Products you confirmed are chosen for you; choose the rest and the supplier. Nothing here changes your stock.');
    setConfirmed(false);
    setSubmitted(false);
    setStage('review');
  };

  /** Follows a scan in the background until it is ready to review or has failed. */
  const follow = useCallback(
    async (id) => {
      setStage('processing');
      setStep('scan');
      for (let i = 0; i < 400 && !cancelled.current; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const u = await aiBillingService.get(id);
        setUpload(u);
        if (u.status === 'completed') return u.ocrSummary ? showOcr(u) : toReview(u);
        if (u.status === 'failed') {
          setFailure(u.error?.message || 'The invoice could not be read.');
          setStage('upload');
          return recent.reload();
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
      return undefined;
    },
    [toReview, showOcr, recent],
  );

  useEffect(() => {
    if (stage !== 'processing' && stage !== 'ai') return undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the elapsed-seconds counter starts with each scan
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [stage]);

  const manual = (withNotice = '') => {
    setR(blankReview());
    setConfirmed(false);
    setSubmitted(false);
    setNotice(withNotice);
    setStage('review');
  };

  /** Scan Invoice: store the file, then read it. If no reading service is connected the file stays stored and the user is taken to enter the details by hand. */
  const scan = async () => {
    if (!file || busy) return;
    setFailure('');
    setNotice('');
    setBusy(true);
    try {
      let u = upload;
      if (u?.status === 'completed' && u.ocrSummary) return await showOcr(u); // already read: show it, never read it twice
      if (!u) {
        setStage('processing');
        setStep('upload');
        setProgress(0);
        u = await aiBillingService.upload(file, setProgress);
        setUpload(u);
        recent.reload();
        if (u.duplicateOf) toast(`This looks like an invoice you already uploaded (${u.duplicateOf.uploadId}).`, { icon: 'ℹ️' });
      }
      try {
        const started = await aiBillingService.scan(u._id);
        setUpload(started);
        await follow(u._id);
      } catch (e) {
        if (e.status === 501) {
          manual(
            `The invoice was uploaded (${u.uploadId}) but nothing was read: ${e.message.replace(/^No invoice-reading service is connected\.\s*/, 'no invoice-reading service is connected. ')} Enter the details from the document shown beside the form.`,
          );
        } else if (e.status === 409) {
          await follow(u._id); // someone (another tab) is already reading it, or it was just read: follow that
        } else {
          throw e;
        }
      }
    } catch (e) {
      setFailure(e.message);
      setStage('upload');
    } finally {
      setBusy(false);
    }
  };

  /** Reprocess: read the document again; the new result replaces the old one. */
  const reprocess = async () => {
    if (!upload || busy) return;
    setBusy(true);
    setFailure('');
    try {
      setUpload(await aiBillingService.reprocess(upload._id));
      setOcr(null);
      await follow(upload._id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** From the OCR results to the review: with the structured draft if a service produced one, otherwise a blank form to fill in beside the document. */
  const continueToReview = () => {
    if (upload?.extraction) toReview(upload);
    else manual('The text below was read by software and has not been checked. Enter the invoice details from the document shown beside the form.');
  };

  /** Reopens an earlier upload (from the recent list or a link). */
  const open = useCallback(
    async (id) => {
      try {
        const u = await aiBillingService.get(id);
        setUpload(u);
        setFileInfo({ name: u.fileName, size: u.size, type: u.mimeType });
        setFailure(u.status === 'failed' ? u.error?.message || 'The invoice could not be read.' : '');
        if (u.hasFile) setFile(await aiBillingService.file(id));
        if (u.status === 'completed') await (u.ocrSummary ? showOcr(u) : toReview(u));
        else if (u.status === 'processing') await follow(id);
        else if (u.status === 'drafted') toast('A draft order was already saved from this invoice.', { icon: 'ℹ️' });
      } catch (e) {
        toast.error(e.message);
      }
    },
    [toReview, showOcr, follow],
  );
  const wanted = params.get('upload');
  useEffect(() => {
    if (wanted && !upload) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- opening a linked upload is a one-time load
      open(wanted);
    }
  }, [wanted, upload, open]);

  /** A typed name is checked against the products the same careful way as an invoice read by the service. */
  const matchByName = async (l) => {
    if (l.product || !l.name.trim()) return;
    try {
      const d = await aiBillingService.match({ items: [{ name: l.name, sku: l.sku }] });
      const m = d.items[0].match;
      setR((x) => ({
        ...x,
        lines: x.lines.map((y) =>
          y.key === l.key
            ? {
                ...y,
                match: m,
                ...(m.status === 'exact' && {
                  product: productFrom(m.candidates[0]),
                  manufacturer: y.manufacturer || m.candidates[0].manufacturer || '',
                  gstPercent: y.gstPercent === '' ? String(m.candidates[0].gstPercent ?? '') : y.gstPercent,
                }),
              }
            : y,
        ),
      }));
    } catch {
      /* the user can still choose the product by hand */
    }
  };

  const errors = r ? validateReview(r, { confirmed }) : {};
  const totals = r ? reviewTotals(r) : null;

  const saveDraft = async (acknowledgeDuplicate = false) => {
    setSubmitted(true);
    setServerError('');
    setDuplicate(null);
    if (busy || Object.keys(errors).length) return;
    setBusy(true);
    try {
      const { idempotencyKey, ...order } = toDraftOrderPayload(r, { userName: user?.name || 'the user', status: 'draft', idempotencyKey: key });
      let created;
      if (upload)
        created = (
          await aiBillingService.draft(upload._id, {
            ...Object.fromEntries(Object.entries(order).filter(([k]) => k !== 'status')),
            reviewed: reviewedSnapshot(r),
            ...(acknowledgeDuplicate === true && { acknowledgeDuplicate: true }),
          })
        ).order;
      else created = await orderService.create({ ...order, idempotencyKey });
      toast.success(`Draft order ${created.orderNo} saved — nothing was added to stock.`);
      navigate('/orders', { state: { openOrder: created._id } });
    } catch (e) {
      if (e.code === 'DUPLICATE_INVOICE') setDuplicate(e.details || []);
      setServerError(e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Cancel: leave without saving. An uploaded file that has not been used is removed from the server too. */
  const leave = async () => {
    setBusy(true);
    try {
      if (upload && ['uploaded', 'failed', 'completed'].includes(upload.status)) await aiBillingService.remove(upload._id);
    } catch {
      /* leaving still works; the file can be removed later */
    }
    navigate('/orders');
  };

  if (!canUse) {
    return (
      <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
        <Card className="rounded-2xl">
          <EmptyState icon={ScanLine} title="AI Billing is for people who place orders" hint="Ask an administrator for stock-management access." />
        </Card>
      </div>
    );
  }

  const st = status.data;
  const hasFile = Boolean(file && fileInfo);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">AI Billing</h1>
            <p className="mt-0.5 text-sm text-muted">Upload a supplier invoice, check what was read, and save it as a draft order.</p>
          </div>
          <Link to="/orders" className="text-sm font-semibold text-primary hover:underline">
            Back to orders
          </Link>
        </div>

        {/* ---- upload ---- */}
        {stage === 'upload' && (
          <div className="space-y-4 border-t border-line p-4 sm:p-5">
            {status.error ? (
              <ErrorState message={status.error} onRetry={status.reload} />
            ) : status.loading && !st ? (
              <Skeleton className="h-16 w-full" />
            ) : st && !st.configured ? (
              <div role="status" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <div>
                  <p className="font-semibold text-warning">Invoice reading isn’t connected yet</p>
                  <p className="mt-1 text-muted">
                    This system has no OCR or AI service of its own, so an uploaded invoice can’t be read automatically. {st.setup} You can still upload the invoice and enter its
                    details by hand while looking at it: the same review, product matching and draft order apply.
                  </p>
                </div>
              </div>
            ) : st ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" /> Invoices are read by <b className="text-ink">{st.ocr?.configured ? st.ocr.label : st.label}</b>
                . Nothing is saved until you have checked it.
              </p>
            ) : null}

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                choose(e.dataTransfer.files?.[0]);
              }}
              className="rounded-xl border-2 border-dashed border-line p-6 text-center"
            >
              <Upload className="mx-auto h-8 w-8 text-muted" aria-hidden="true" />
              <p className="mt-2 text-sm font-semibold">Drag and drop the supplier’s invoice here</p>
              <p className="text-xs text-muted">PDF, JPG, JPEG or PNG, up to 10 MB</p>
              <input
                ref={input}
                type="file"
                aria-label="Invoice file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                className="sr-only"
                onChange={(e) => choose(e.target.files?.[0])}
              />
              <Button variant="secondary" className="mt-3" onClick={() => input.current?.click()}>
                Browse Files
              </Button>
            </div>
            {fileError && (
              <p role="alert" className="flex items-center gap-2 text-sm text-danger">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" /> {fileError}
              </p>
            )}

            {hasFile && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <div className="flex items-center gap-3 self-start rounded-xl border border-line p-3 text-sm">
                  {fileInfo.type === 'application/pdf' ? (
                    <FileText className="h-8 w-8 shrink-0 text-muted" aria-hidden="true" />
                  ) : (
                    <ImageIcon className="h-8 w-8 shrink-0 text-muted" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{fileInfo.name}</div>
                    <div className="text-xs text-muted">
                      {fileSize(fileInfo.size)} · {fileInfo.type === 'application/pdf' ? 'PDF' : fileInfo.type === 'image/png' ? 'PNG' : 'JPEG'}
                      {upload ? ` · ${upload.uploadId}` : ''}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={removeFile} disabled={busy} aria-label="Remove File">
                    <Trash2 className="h-4 w-4" /> <span className="hidden sm:inline">Remove File</span>
                  </Button>
                </div>
                <DocumentPreview file={file} type={fileInfo.type} name={fileInfo.name} />
              </div>
            )}

            {failure && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {failure}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              {upload && (
                <span className="mr-auto flex items-center gap-2 text-xs text-muted" aria-label="Scan status">
                  Status: <Badge tone={STATUS_TONE[upload.status]}>{SCAN_STATE_LABEL[scanState(upload)]}</Badge>
                </span>
              )}
              <Button variant="secondary" onClick={() => manual()} disabled={busy}>
                Enter details manually
              </Button>
              <Button variant="accent" onClick={scan} loading={busy} disabled={!hasFile || busy}>
                {upload?.status === 'failed' ? <RefreshCw className="h-4 w-4" /> : <ScanLine className="h-4 w-4" />} {upload?.status === 'failed' ? 'Retry Scan' : 'Scan Invoice'}
              </Button>
            </div>
          </div>
        )}

        {/* ---- processing ---- */}
        {stage === 'processing' && (
          <div className="space-y-4 border-t border-line p-4 sm:p-5" aria-live="polite">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
              Processing {fileInfo?.name}{' '}
              <Badge tone="info" dot>
                {SCAN_STATE_LABEL[upload ? scanState(upload) : 'uploaded']}
              </Badge>
            </h2>
            <div
              role="progressbar"
              aria-label="Processing progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={step === 'upload' ? progress : undefined}
              className="h-2 overflow-hidden rounded-full bg-subtle"
            >
              <div
                className={cx('h-full rounded-full bg-primary transition-all', step === 'scan' && 'w-1/2 animate-pulse')}
                style={step === 'upload' ? { width: `${progress}%` } : undefined}
              />
            </div>
            <ol className="space-y-3">
              <Step state={step === 'upload' ? 'active' : 'done'} label="Uploading the file" detail={step === 'upload' ? `${progress}%` : 'Stored safely'} />
              <Step
                state={step === 'scan' ? 'active' : 'waiting'}
                label={st?.ocr?.configured ? `Reading the text and tables (${st.ocr.label})` : 'Reading the invoice and matching products'}
                detail={
                  step === 'scan'
                    ? `${seconds} second${seconds === 1 ? '' : 's'} so far — you can leave this page; the scan continues and the upload stays in your recent uploads.`
                    : undefined
                }
              />
              <Step state="waiting" label={st?.ocr?.configured ? 'OCR results ready' : 'Ready for your review'} />
            </ol>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={reset}>
                <Clock3 className="h-4 w-4" /> Stop waiting
              </Button>
            </div>
          </div>
        )}

        {/* ---- OCR results ---- */}
        {stage === 'ocr' && ocr && (
          <OcrResults
            ocr={ocr}
            upload={upload}
            file={file}
            fileInfo={fileInfo}
            busy={busy}
            onReprocess={reprocess}
            onContinue={continueToReview}
            ai={status.data?.ai}
            hasExtraction={Boolean(upload?.aiVersion)}
            aiFailure={aiFailure}
            onExtract={() => extractWithAi(false)}
            onViewExtraction={() => loadExtraction(upload._id).catch((e) => toast.error(e.message))}
            onBack={() => {
              reset();
              recent.reload();
            }}
          />
        )}

        {/* ---- AI extraction running ---- */}
        {stage === 'ai' && (
          <div className="space-y-4 border-t border-line p-4 sm:p-5" aria-live="polite">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
              Extracting {fileInfo?.name}{' '}
              <Badge tone="info" dot>
                AI Processing
              </Badge>
            </h2>
            <div role="progressbar" aria-label="AI extraction progress" className="h-2 overflow-hidden rounded-full bg-subtle">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
            </div>
            <ol className="space-y-3">
              <Step state="done" label="OCR text and tables ready" detail="Read from the document" />
              <Step
                state="active"
                label={`Understanding the invoice (${status.data?.ai?.label || 'AI'})`}
                detail={`${seconds} second${seconds === 1 ? '' : 's'} so far — you can leave this page; the extraction continues.`}
              />
              <Step state="waiting" label="Checking the figures against the document text" />
              <Step state="waiting" label="Ready for your review" />
            </ol>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={reset}>
                <Clock3 className="h-4 w-4" /> Stop waiting
              </Button>
            </div>
          </div>
        )}

        {/* ---- the extracted invoice ---- */}
        {stage === 'extracted' && ex && form && (
          <div className="space-y-4 border-t border-line p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  Extracted invoice <Badge tone={STATE_TONE[ex.state]}>{ex.stateLabel}</Badge>
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  Version {ex.version}
                  {ex.versions?.length > 1 ? ` of ${ex.versions[0].version}` : ''} · read by {ex.provider} ({ex.model}) · {dateTimeFmt(ex.extractedAt)}
                  {ex.editCount ? ` · ${ex.editCount} correction${ex.editCount === 1 ? '' : 's'}` : ''}
                  {upload?.uploadId ? ` · ${upload.uploadId}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setStage('ocr')} disabled={busy}>
                  OCR results
                </Button>
                <Button variant="secondary" onClick={() => setReextracting(true)} disabled={busy}>
                  <RefreshCw className="h-4 w-4" /> Re-extract
                </Button>
              </div>
            </div>
            <div role="status" className="flex items-start gap-3 rounded-xl bg-subtle p-3 text-sm">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <p>
                This was extracted by AI from the OCR text. It is <b>not verified</b>: a person must check it against the document. Outlined values are uncertain or missing; hover
                for where they came from. Nothing here creates an order, matches products or changes stock.
              </p>
            </div>
            <div className={cx('grid gap-4', hasFile && 'xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]')}>
              {hasFile && (
                <div className="space-y-2 xl:sticky xl:top-4 xl:self-start">
                  <h3 className="text-sm font-bold">{fileInfo.name}</h3>
                  <DocumentPreview file={file} type={fileInfo.type} name={fileInfo.name} />
                </div>
              )}
              <InvoiceExtractionEditor ex={ex} form={form} setForm={setForm} errors={exShow ? exErrors : {}} />
            </div>
            <div className="space-y-3 border-t border-line pt-4">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={checkedByMe} onChange={(e) => setCheckedByMe(e.target.checked)} className="mt-1" />
                <span>I have checked this invoice against the document{ex.humanReviewed ? ` (reviewed by ${ex.reviewedByName || 'someone'})` : ''}.</span>
              </label>
              {needAccept && (
                <label className="flex items-start gap-2 text-sm text-danger">
                  <input type="checkbox" checked={acceptIssues} onChange={(e) => setAcceptIssues(e.target.checked)} className="mt-1" />
                  <span>I accept the errors that remain.</span>
                </label>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  onClick={() => (upload && ['uploaded', 'failed', 'completed'].includes(upload.status) ? setDiscarding(true) : navigate('/orders'))}
                  disabled={busy}
                >
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button variant="secondary" onClick={validateNow} disabled={busy}>
                  Validate Invoice
                </Button>
                <Button variant="secondary" onClick={openMatching} disabled={busy}>
                  Match Products
                </Button>
                <Button variant="secondary" onClick={() => persist()} disabled={busy || !exDirty}>
                  Save Changes
                </Button>
                <Button variant="secondary" onClick={() => persist({ reviewed: true })} disabled={busy || !checkedByMe || (ex.humanReviewed && !exDirty)}>
                  Mark as Reviewed
                </Button>
                <Button variant="accent" onClick={extractedToReview} loading={busy} disabled={busy}>
                  <Save className="h-4 w-4" /> Save as Draft
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ---- product matching ---- */}
        {stage === 'matching' && ex && upload && (
          <ProductMatching upload={upload} onBack={() => setStage('extracted')} onContinue={matchingToReview} onProceed={() => setStage('final')} />
        )}

        {/* ---- final review, purchase order and goods receipt ---- */}
        {stage === 'final' && upload && <FinalInvoiceReview upload={upload} onBack={() => setStage('matching')} onProceed={() => setStage('receipt')} />}
        {stage === 'receipt' && upload && (
          <GoodsReceiptForm upload={upload} onBack={() => setStage('final')} onDone={(r) => navigate('/orders', { state: { openOrder: r.order._id } })} />
        )}

        {/* ---- review ---- */}
        {stage === 'review' && r && (
          <div className="space-y-4 border-t border-line p-4 sm:p-5">
            <div role="status" className="flex items-start gap-3 rounded-xl bg-subtle p-3 text-sm">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <p>
                {notice ||
                  (r.source === 'ai' ? 'These details were read from the uploaded invoice by software and may contain mistakes. ' : 'You are entering the invoice by hand. ')}
                {!notice && 'Check every line. A product is only chosen for you when it matches exactly; otherwise you choose it. Nothing here changes your stock.'}
              </p>
            </div>
            {ocr && (
              <div className="flex flex-wrap gap-2">
                {ex && (
                  <Button size="sm" variant="ghost" onClick={() => setStage('extracted')}>
                    Back to extracted invoice
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setStage('ocr')}>
                  View OCR results
                </Button>
              </div>
            )}
            <div className={cx('grid gap-4', hasFile && 'xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]')}>
              {hasFile && (
                <div className="space-y-2 xl:sticky xl:top-4 xl:self-start">
                  <h2 className="text-sm font-bold">{fileInfo.name}</h2>
                  <DocumentPreview file={file} type={fileInfo.type} name={fileInfo.name} />
                  <p className="text-xs text-muted">
                    {fileSize(fileInfo.size)}
                    {upload ? ` · ${upload.uploadId}` : ''}
                  </p>
                </div>
              )}
              <InvoiceReview
                r={r}
                setR={setR}
                errors={errors}
                show={submitted}
                suppliers={suppliers}
                onAddSupplier={() => setAddingSupplier(true)}
                totals={totals}
                confirmed={confirmed}
                setConfirmed={setConfirmed}
                onMatchName={matchByName}
              />
            </div>
            {duplicate && (
              <div role="alert" className="space-y-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm">
                <p className="font-semibold text-danger">This invoice looks like a duplicate</p>
                <p>An order for this supplier’s invoice number already exists: {duplicate.map((d) => d.reference).join(', ')}. Saving again would create a second record.</p>
                {(user?.permissions || []).includes('orders:approve') ? (
                  <Button size="sm" variant="secondary" onClick={() => saveDraft(true)} disabled={busy}>
                    It is a different invoice — save anyway
                  </Button>
                ) : (
                  <p className="text-muted">Ask someone who can approve orders to look into it if this is a legitimate second invoice.</p>
                )}
              </div>
            )}
            {serverError && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {serverError}
              </p>
            )}
            {submitted && Object.keys(errors).length > 0 && !busy && (
              <p role="status" className="text-sm text-danger">
                Please fix the highlighted items before saving the draft.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              <Button
                variant="secondary"
                onClick={() => (upload && ['uploaded', 'failed', 'completed'].includes(upload.status) ? setDiscarding(true) : navigate('/orders'))}
                disabled={busy}
              >
                <X className="h-4 w-4" /> Cancel
              </Button>
              <Button variant="accent" onClick={() => saveDraft()} loading={busy}>
                <Save className="h-4 w-4" /> Save as Draft
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ---- recent uploads ---- */}
      {stage === 'upload' && (
        <Card className="rounded-2xl">
          <div className="p-4 sm:p-5">
            <h2 className="text-sm font-bold">Recent uploads</h2>
            {recent.error ? (
              <ErrorState message={recent.error} onRetry={recent.reload} />
            ) : !recent.data ? (
              <Skeleton className="mt-3 h-12 w-full" />
            ) : !recent.data.items ? null : recent.data.items.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing uploaded yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line text-sm" aria-label="Recent uploads">
                {recent.data.items.map((u) => (
                  <li key={u._id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{u.fileName}</div>
                      <div className="text-xs text-muted">
                        {u.uploadId} · {fileSize(u.size)} · {dateTimeFmt(u.createdAt)}
                        {u.uploadedByName ? ` · ${u.uploadedByName}` : ''}
                      </div>
                      {u.status === 'failed' && u.error?.message && <div className="text-xs text-danger">{u.error.message}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={STATUS_TONE[u.status]}>{u.statusLabel}</Badge>
                      {u.orderId && (
                        <Link to="/orders" state={{ openOrder: u.orderId }} className="text-xs font-semibold text-primary hover:underline">
                          View order
                        </Link>
                      )}
                      {u.hasFile && u.status !== 'drafted' && (
                        <Button size="sm" variant="secondary" onClick={() => open(u._id)} aria-label={`Open upload ${u.uploadId}`}>
                          Open
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {reextracting && (
        <ConfirmDialog
          title="Extract this invoice again?"
          message="The AI will read the OCR text again and add a new version. The current version, with your corrections, is kept in its history but does not carry over."
          confirmLabel="Re-extract"
          loading={busy}
          onConfirm={async () => {
            setReextracting(false);
            await extractWithAi(true);
          }}
          onClose={() => !busy && setReextracting(false)}
        />
      )}
      {addingSupplier && (
        <NewSupplierDialog
          onClose={() => setAddingSupplier(false)}
          onDone={(s) => {
            setAddingSupplier(false);
            suppliers.reload();
            setR((x) => ({ ...x, supplierId: s._id }));
          }}
        />
      )}
      {discarding && (
        <ConfirmDialog
          title="Discard this invoice?"
          message="The uploaded file and what was read from it will be removed. Nothing has been saved as an order."
          confirmLabel="Discard"
          danger
          loading={busy}
          onConfirm={leave}
          onClose={() => !busy && setDiscarding(false)}
        />
      )}
    </div>
  );
}
