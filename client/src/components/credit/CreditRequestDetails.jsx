import { useState } from 'react';
import toast from 'react-hot-toast';
import { creditService } from '../../services/creditService';
import { LOG_TEXT, STATUS_TEXT, STATUS_TONE, amountProblem, announceCreditsChanged, creditWord, creditsFor, rupees } from '../../utils/credit';
import { dateTimeFmt } from '../../utils/format';
import { Badge, Button, ConfirmDialog, Input, Modal } from '../common/ui';
import { ProofImage } from './CreditProof';

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{children}</dd>
    </div>
  );
}

/** One request: its details, the payment screenshot (fetched through the authenticated endpoint) and the log of what happened to it. */
export default function CreditRequestDetails({ request: r, showUser, canReview, onClose, onReviewed }) {
  return (
    <Modal title={`Credit request ${r.requestNo}`} description={`Submitted ${dateTimeFmt(r.createdAt)}`} onClose={onClose} wide>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <dl className="divide-y divide-line" aria-label="Request details">
            {showUser && <Row label="Requested by">{dash(r.userName)}</Row>}
            <Row label="Requested amount">{rupees(r.amount)}</Row>
            <Row label="Conversion rate">1 credit = {rupees(r.rateAtRequest)}</Row>
            <Row label="Estimated credits">{r.suggestedCredits} (the administrator decides the final credits)</Row>
            <Row label="Status">
              <Badge tone={STATUS_TONE[r.status]} dot>
                {STATUS_TEXT[r.status] || r.status}
              </Badge>
            </Row>
            {r.approvedAmount != null && <Row label="Approved amount">{rupees(r.approvedAmount)}</Row>}
            <Row label="Approved credits">{r.approvedCredits != null ? r.approvedCredits : '—'}</Row>
            {r.status === 'approved' && r.approvedRate != null && (
              <Row label="Calculation">
                {rupees(r.approvedAmount)} ÷ {rupees(r.approvedRate)} per credit = {r.approvedCredits} credits{r.remainderAmount > 0 ? ` (${rupees(r.remainderAmount)} left over, not converted)` : ''}
              </Row>
            )}
            {r.reviewedByName && <Row label="Reviewed by">{`${r.reviewedByName}${r.reviewedAt ? ` · ${dateTimeFmt(r.reviewedAt)}` : ''}`}</Row>}
            {r.remarks && <Row label="Admin remarks">{r.remarks}</Row>}
          </dl>
          {canReview && r.status === 'pending' && <ReviewPanel request={r} onDone={onReviewed} />}
          <section aria-label="Request log">
            <h3 className="text-sm font-bold">Log</h3>
            <ol className="mt-2 space-y-2 border-l border-line pl-4 text-sm">
              {(r.history || []).map((h, i) => (
                <li key={i}>
                  <div className="font-semibold">{LOG_TEXT[h.action] || h.action}</div>
                  <div className="text-xs text-muted">
                    {dateTimeFmt(h.at)}
                    {h.byName ? ` · ${h.byName}` : ''}
                  </div>
                  {h.note && <div className="text-xs">{h.note}</div>}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-bold">Payment screenshot</h3>
          <ProofImage request={r} />
          <p className="text-xs text-muted">
            {r.screenshot?.fileName} · {r.screenshot?.mimeType}
          </p>
        </div>
      </div>
    </Modal>
  );
}

/** An administrator decides: the approved payment amount (starts as the requested one), a live preview of the credits it gives, and remarks. The server does the calculation. */
function ReviewPanel({ request: r, onDone }) {
  const [amount, setAmount] = useState(String(r.amount));
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState('');
  const [error, setError] = useState('');
  const problem = amountProblem(amount);
  const calc = problem ? null : creditsFor(amount, r.rateAtRequest);
  /** Checks what was typed, then asks before doing something that cannot be undone. */
  const ask = (kind) => {
    setError('');
    if (kind === 'approve' && problem) return setError(problem);
    if (kind === 'reject' && remarks.trim().length < 3) return setError('Give a reason for rejecting (at least 3 characters)');
    setConfirming(kind);
  };
  const act = async (kind) => {
    setError('');
    setBusy(kind);
    try {
      const done = kind === 'approve' ? await creditService.approve(r._id, amount.trim(), remarks.trim() || undefined) : await creditService.reject(r._id, remarks.trim());
      if (kind === 'approve') {
        const t = done.transaction;
        toast.success(`${r.requestNo} approved: ${creditWord(done.approvedCredits)} added to ${r.userName || 'the requester'}${t ? ` (balance ${t.previousBalance} → ${t.newBalance}, ${t.txnNo})` : ''}`);
        announceCreditsChanged(); // the balance in the header updates at once
      } else toast.success(`${r.requestNo} rejected. No credits were added.`);
      onDone?.(done);
    } catch (ex) {
      setError(ex.message);
    } finally {
      setBusy('');
      setConfirming('');
    }
  };
  return (
    <section aria-label="Review request" className="space-y-3 rounded-xl border border-line bg-subtle p-4">
      <h3 className="text-sm font-bold">Review</h3>
      <p className="text-xs text-muted">
        Check the payment screenshot against the amount requested ({rupees(r.amount)}), then enter the amount you have verified. Approving adds the credits to {r.userName || 'the requester'}
        ’s balance and writes a ledger entry; it cannot be undone here.
      </p>
      <Input label="Approved payment amount (₹)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={problem && amount !== '' ? problem : undefined} hint={calc ? `${calc.credits} credits at ₹${r.rateAtRequest} per credit${calc.remainder > 0 ? `; ${rupees(calc.remainder)} left over` : ''}. The server confirms the final figure.` : undefined} />
      <Input label="Admin remarks" value={remarks} maxLength={300} onChange={(e) => setRemarks(e.target.value)} hint="Kept on the request and shown to the requester. Required when rejecting." />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button loading={busy === 'approve'} disabled={!!busy} onClick={() => ask('approve')}>Approve</Button>
        <Button variant="secondary" loading={busy === 'reject'} disabled={!!busy} onClick={() => ask('reject')}>Reject</Button>
      </div>
      {confirming === 'approve' && (
        <ConfirmDialog
          title="Approve this credit request?"
          message={`${rupees(amount)} will be approved on ${r.requestNo} and ${creditWord(calc?.credits)} added to ${r.userName || 'the requester'}’s balance. This cannot be undone.`}
          confirmLabel="Approve and add credits"
          loading={busy === 'approve'}
          onConfirm={() => act('approve')}
          onClose={() => setConfirming('')}
        />
      )}
      {confirming === 'reject' && (
        <ConfirmDialog
          danger
          title="Reject this credit request?"
          message={`${r.requestNo} will be rejected and no credits will be added. The requester will see your reason: “${remarks.trim()}”`}
          confirmLabel="Reject request"
          loading={busy === 'reject'}
          onConfirm={() => act('reject')}
          onClose={() => setConfirming('')}
        />
      )}
    </section>
  );
}
