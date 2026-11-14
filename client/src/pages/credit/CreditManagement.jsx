import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import CreditHistory from '../../components/credit/CreditHistory';
import CreditLedger from '../../components/credit/CreditLedger';
import CreditRequestForm from '../../components/credit/CreditRequestForm';
import { ErrorState, Skeleton, cx } from '../../components/common/ui';

const TABS = [
  ['request', 'Request Credit'],
  ['history', 'History & Logs'],
  ['ledger', 'Credit Ledger'],
  ['approvals', 'Approvals', 'settings:manage'], // administrators only: the review queue
];

/**
 * Credit Management: request credits by paying and uploading a screenshot of the payment, follow the requests (status and log), see the credit balance and the
 * ledger behind it, and — for administrators — review what others have submitted. The conversion rate and upload limits come from the server's settings. The
 * chosen tab is kept in the address (?tab=history).
 */
export default function CreditManagement() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const canSeeAll = (user?.permissions || []).includes('settings:manage');
  const tabs = TABS.filter(([, , need]) => !need || (user?.permissions || []).includes(need));
  const asked = params.get('tab');
  const tab = tabs.some(([key]) => key === asked) ? asked : 'request';
  const settings = useFetch('/credits/settings');
  const [refresh, setRefresh] = useState(0);
  const go = (t) => setParams(t === 'request' ? {} : { tab: t }, { replace: true });

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Finance Management</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Credit Management</h1>
        <p className="mt-1 text-sm text-muted">Request credit, upload payment screenshots, and view your request history.</p>
      </header>

      <div role="tablist" aria-label="Credit management" className="flex gap-6 border-b border-line">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            id={`credit-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`credit-panel-${key}`}
            onClick={() => go(key)}
            className={cx(
              '-mb-px border-b-2 px-1 pb-3 text-sm font-semibold transition-colors',
              tab === key ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'request' && (
        <div role="tabpanel" id="credit-panel-request" aria-labelledby="credit-tab-request" className="py-2">
          {settings.error ? (
            <ErrorState message={settings.error} onRetry={settings.reload} />
          ) : !settings.data ? (
            <Skeleton className="mx-auto h-96 w-full max-w-xl" />
          ) : (
            <CreditRequestForm settings={settings.data} onSubmitted={() => setRefresh((n) => n + 1)} />
          )}
        </div>
      )}
      {tab === 'history' && (
        <div role="tabpanel" id="credit-panel-history" aria-labelledby="credit-tab-history">
          <CreditHistory canSeeAll={canSeeAll} refreshKey={refresh} onReviewed={() => setRefresh((n) => n + 1)} />
        </div>
      )}
      {tab === 'ledger' && (
        <div role="tabpanel" id="credit-panel-ledger" aria-labelledby="credit-tab-ledger">
          <CreditLedger canSeeAll={canSeeAll} refreshKey={refresh} />
        </div>
      )}
      {tab === 'approvals' && canSeeAll && (
        <div role="tabpanel" id="credit-panel-approvals" aria-labelledby="credit-tab-approvals" className="space-y-3">
          <p className="text-sm text-muted">
            Every credit request of the organization. Check the payment proof, enter the amount you have verified and approve or reject it — approving adds the credits to that
            person&rsquo;s balance and writes a ledger entry. You cannot review your own request.
          </p>
          <CreditHistory mode="review" canSeeAll={canSeeAll} refreshKey={refresh} onReviewed={() => setRefresh((n) => n + 1)} />
        </div>
      )}
    </div>
  );
}
