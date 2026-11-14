import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, Bell, CalendarClock, CheckCircle2, Coins, FileBadge, LineChart, PackageCheck, PackageOpen, Send, ThumbsDown, ThumbsUp, Truck } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { dateFmt, expiryFmt, inr, timeAgo } from '../../utils/format';
import { Dropdown } from '../common/Dropdown';
import { IconButton, cx } from '../common/ui';

const TRANSFER_ICON = {
  submitted: Send,
  approved: ThumbsUp,
  rejected: ThumbsDown,
  dispatched: Truck,
  partial: PackageOpen,
  completed: PackageCheck,
};
const TRANSFER_TONE = {
  rejected: 'text-danger',
  completed: 'text-success',
  approved: 'text-success',
  partial: 'text-warning',
};
const seenKey = (user) => `usha:notif-seen:${user?.id || 'me'}`;
const readSeen = (user) => {
  try {
    return Number(localStorage.getItem(seenKey(user))) || 0;
  } catch {
    return 0;
  }
};

/** Live low-stock and expiry alerts from /dashboard/alerts, plus stock-transfer updates from /transfers/notifications
 *  (submitted, approved, rejected, dispatched, received, partial receipt, completed) and the person's own decided credit requests from
 *  /credits/notifications. All of it is derived from the records themselves — nothing is stored twice. "New" is remembered per person in the browser. */
export default function NotificationDropdown() {
  const { data, loading, error, reload } = useFetch('/dashboard/alerts');
  // Which alerts this organization wants (Common Settings -> Notifications). The server always sends the lists - the
  // dashboard cards read them too - so turning an alert off only quietens THIS bell, never the figures elsewhere.
  // Until the server has answered, nothing is hidden: the defaults are "low stock and expiry on", as they always were.
  const wants = data?.notifications || { lowStock: true, nearExpiry: true, licenseExpiry: true, dailySummary: false };
  const low = wants.lowStock ? data?.lowStockItems || [] : [];
  const exp = wants.nearExpiry ? data?.expiringBatches || [] : [];
  const licences = wants.licenseExpiry ? data?.licenses || [] : [];
  const summary = wants.dailySummary ? data?.dailySummary || null : null;
  const { user } = useAuth();
  const canSeeTransfers = (user?.permissions || []).includes('transfer:view');
  const [transfers, setTransfers] = useState([]);
  const [credits, setCredits] = useState([]);
  const [seenAt, setSeenAt] = useState(() => readSeen(user));
  const loadTransfers = useCallback(() => {
    if (!canSeeTransfers) return;
    api
      .get('/transfers/notifications')
      .then(setTransfers)
      .catch(() => {}); // alerts still work if this fails
  }, [canSeeTransfers]);
  // every signed-in person can have credit requests of their own, so this needs no permission
  const loadCredits = useCallback(() => {
    api
      .get('/credits/notifications')
      .then(setCredits)
      .catch(() => {}); // the other notifications still work if this fails
  }, []);
  const loadAll = useCallback(() => {
    loadTransfers();
    loadCredits();
  }, [loadTransfers, loadCredits]);
  useEffect(() => {
    loadAll();
    const timer = setInterval(loadAll, 60000);
    return () => clearInterval(timer);
  }, [loadAll]);
  const fresh = (at) => new Date(at).getTime() > seenAt;
  const unread = [...transfers, ...credits].filter((n) => fresh(n.at)).length;
  const markSeen = () => {
    const now = Date.now();
    try {
      localStorage.setItem(seenKey(user), String(now));
    } catch {
      /* private mode: the badge just reappears next time */
    }
    setSeenAt(now);
  };
  const count = low.length + exp.length + licences.length + unread;

  return (
    <Dropdown
      width="w-80"
      label="Notifications"
      trigger={({ toggle, props }) => (
        <div className="relative">
          <IconButton
            label={count ? `Notifications (${count})` : 'Notifications'}
            {...props}
            onClick={() => {
              reload();
              loadAll();
              toggle();
            }}
          >
            <Bell className="h-[18px] w-[18px]" />
          </IconButton>
          {count > 0 && (
            <span className="pointer-events-none absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-on-danger">
              {count}
            </span>
          )}
        </div>
      )}
    >
      {(rawClose) => {
        const close = () => {
          markSeen();
          rawClose();
        };
        return (
          <div>
            <div className="border-b border-line px-4 py-3 text-sm font-bold">Notifications</div>
            <div className="max-h-80 overflow-y-auto">
              {loading && !data ? (
                <p className="px-4 py-6 text-center text-sm text-muted">Loading…</p>
              ) : error ? (
                <p className="px-4 py-6 text-center text-sm text-danger">{error}</p>
              ) : low.length + exp.length + licences.length + transfers.length + credits.length === 0 && !summary ? (
                <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center text-sm text-muted">
                  <CheckCircle2 className="h-6 w-6 text-success" aria-hidden="true" />
                  You're all caught up.
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {summary && (
                    <li>
                      <Link to="/analytics" onClick={close} className="flex gap-3 px-4 py-3 hover:bg-subtle">
                        <LineChart className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                        <span className="text-sm">
                          <span className="font-semibold">Yesterday: {inr(summary.sales)}</span>
                          <span className="block text-xs text-muted">
                            {summary.invoices.toLocaleString('en-IN')} invoice{summary.invoices === 1 ? '' : 's'} · {dateFmt(summary.date)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  )}
                  {licences.map((l) => (
                    <li key={`lic-${l.type}-${l.number}`}>
                      <Link to="/settings/organization" onClick={close} className="flex gap-3 px-4 py-3 hover:bg-subtle">
                        <FileBadge className={cx('mt-0.5 h-4 w-4 shrink-0', l.expired ? 'text-danger' : 'text-warning')} aria-hidden="true" />
                        <span className="text-sm">
                          <span className="font-semibold">Drug licence {l.type}</span>{' '}
                          <span className="text-muted">
                            {l.number} {l.expired ? `lapsed ${Math.abs(l.daysToExpiry)} day${Math.abs(l.daysToExpiry) === 1 ? '' : 's'} ago` : `lapses in ${l.daysToExpiry} day${l.daysToExpiry === 1 ? '' : 's'}`}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                  {transfers.slice(0, 12).map((n) => {
                    const Icon = TRANSFER_ICON[n.kind] || ArrowLeftRight;
                    const isNew = fresh(n.at);
                    return (
                      <li key={`t-${n.id}`}>
                        <Link
                          to={`/inventory/transfers?search=${encodeURIComponent(n.reference)}`}
                          onClick={close}
                          className={cx('flex gap-3 px-4 py-3 hover:bg-subtle', isNew && 'bg-sage/40')}
                        >
                          <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', TRANSFER_TONE[n.kind] || 'text-muted')} aria-hidden="true" />
                          <span className="text-sm">
                            <span className="font-semibold">{n.message}</span>
                            <span className="block text-xs text-muted">
                              {n.route} · {timeAgo(n.at)}
                              {n.by ? ` · ${n.by}` : ''}
                              {isNew && <span className="ml-1 font-semibold text-success">· New</span>}
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                  {credits.slice(0, 8).map((n) => (
                    <li key={`c-${n._id}`}>
                      <Link
                        to="/credit?tab=history"
                        onClick={close}
                        className={cx('flex gap-3 px-4 py-3 hover:bg-subtle', fresh(n.at) && 'bg-sage/40')}
                      >
                        <Coins className={cx('mt-0.5 h-4 w-4 shrink-0', n.status === 'approved' ? 'text-success' : 'text-danger')} aria-hidden="true" />
                        <span className="text-sm">
                          <span className="font-semibold">{n.message}</span>
                          <span className="block text-xs text-muted">
                            Credit request · {timeAgo(n.at)}
                            {n.by ? ` · ${n.by}` : ''}
                            {fresh(n.at) && <span className="ml-1 font-semibold text-success">· New</span>}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                  {low.map((m) => (
                    <li key={`l-${m.id}`}>
                      <Link to="/inventory?stock=low_stock" onClick={close} className="flex gap-3 px-4 py-3 hover:bg-subtle">
                        <AlertTriangle className={cx('mt-0.5 h-4 w-4 shrink-0', m.qty === 0 ? 'text-danger' : 'text-warning')} aria-hidden="true" />
                        <span className="text-sm">
                          <span className="font-semibold">{m.name}</span>{' '}
                          <span className="text-muted">{m.qty === 0 ? 'is out of stock' : `is low (${m.qty} left, reorder at ${m.reorderLevel})`}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                  {exp.map((b) => (
                    <li key={`e-${b.id}`}>
                      <Link to="/inventory" onClick={close} className="flex gap-3 px-4 py-3 hover:bg-subtle">
                        <CalendarClock className={cx('mt-0.5 h-4 w-4 shrink-0', b.expired ? 'text-danger' : 'text-warning')} aria-hidden="true" />
                        <span className="text-sm">
                          <span className="font-semibold">{b.name}</span>{' '}
                          <span className="text-muted">
                            batch {b.batchNumber} {b.expired ? 'expired' : 'expires'} {expiryFmt(b.expiryDate)} · {b.quantity} units
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      }}
    </Dropdown>
  );
}
