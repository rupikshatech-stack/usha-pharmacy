import { useEffect } from 'react';
import { ArrowLeftRight, Building2, Calendar, History, Package, Percent, Trash2, TrendingUp, Truck, X } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { Badge, Button, ErrorState, IconButton, Skeleton, cx } from '../../common/ui';
import { useFetch } from '../../../hooks/useFetch';
import { dateTimeFmt, expiryFmt, inr } from '../../../utils/format';
import { ACTION_LABEL, availableActions, countdownLabel } from '../../../utils/expiryView';
import { RiskBadge } from './RiskBadge';

/** One labelled fact. */
const Fact = ({ label, children, className }) => (
  <div className={className}>
    <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</dt>
    <dd className="mt-0.5 text-sm font-medium">{children}</dd>
  </div>
);

const Section = ({ icon: Icon, title, children, hint }) => (
  <section className="border-t border-line px-5 py-4">
    <h3 className="flex items-center gap-2 text-[13px] font-bold">
      <Icon className="h-4 w-4 text-muted" aria-hidden="true" />
      {title}
    </h3>
    {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    <div className="mt-3">{children}</div>
  </section>
);

const MOVEMENT_WORD = {
  OPENING: 'Opening stock',
  PURCHASE: 'Received',
  SALE: 'Sold',
  SALE_RETURN: 'Customer return',
  ADJUSTMENT: 'Adjustment',
  WRITE_OFF: 'Written off',
  TRANSFER_IN: 'Transferred in',
  TRANSFER_OUT: 'Transferred out',
};

/**
 * Everything behind one row of the register, in a panel beside it.
 *
 * The register answers "what should I deal with first". This answers the question that follows — "why does it say
 * that, and what has already happened to this lot" — which is where the sales history and the two trails come in. A
 * figure a pharmacist cannot interrogate is a figure they will not act on.
 */
export default function BatchDrawer({ row, onClose, onAction }) {
  const { data, loading, error, reload } = useFetch(row ? `/analytics/expiry/batches/${row.id}` : null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!row) return null;
  const actions = availableActions(row);
  const spark = data?.salesHistory || [];

  return (
    <div className="anim-fade fixed inset-0 z-50 flex justify-end" style={{ background: 'var(--overlay)' }} onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${row.medicineName}, batch ${row.batchNumber}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="anim-pop flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-line bg-card shadow-pop"
      >
        {/* Header: what this lot is, and how bad it is, without scrolling. */}
        <header className="shrink-0 border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent">Batch {row.batchNumber}</p>
              <h2 className="mt-1 truncate text-lg font-bold">{row.medicineName}</h2>
              <p className="truncate text-sm text-muted">
                {[row.strength, row.packSize, row.manufacturer].filter(Boolean).join(' · ') || 'No pack details recorded'}
              </p>
            </div>
            <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <RiskBadge level={row.riskLevel} score={row.riskScore} />
            <Badge tone={row.daysToExpiry <= 0 ? 'danger' : 'neutral'}>{countdownLabel(row.daysToExpiry)}</Badge>
            {row.scheduleCategory && <Badge tone="purple">Schedule {row.scheduleCategory}</Badge>}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {error ? (
            <div className="p-5">
              <ErrorState message={error} onRetry={reload} />
            </div>
          ) : (
            <>
              {/* Why it is ranked where it is — the arithmetic, spelled out. */}
              <Section icon={TrendingUp} title="Why it is ranked here" hint={`Demand measured per medicine per store, then shared across this medicine's lots earliest-expiry-first.`}>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  <Fact label="On hand">
                    {row.quantity.toLocaleString('en-IN')} {row.unit}
                  </Fact>
                  <Fact label="Sells">{row.avgDailySales} a day</Fact>
                  <Fact label="Days left">{row.daysToExpiry}</Fact>
                  <Fact label="Likely to sell">{row.expectedSales.toLocaleString('en-IN')}</Fact>
                  <Fact label="Likely left over">
                    <span className={row.projectedUnsoldQty > 0 ? 'text-danger' : ''}>{row.projectedUnsoldQty.toLocaleString('en-IN')}</span>
                  </Fact>
                  <Fact label="Projected loss">
                    <span className={cx('font-bold', row.projectedLoss > 0 && 'text-danger')}>{inr(row.projectedLoss)}</span>
                  </Fact>
                </dl>
                {row.projectedUnsoldQty > 0 && row.daysToExpiry > 0 && (
                  <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-xs text-muted">
                    At {row.avgDailySales} a day this store would sell about {row.expectedSales.toLocaleString('en-IN')} of the {row.quantity.toLocaleString('en-IN')} units before{' '}
                    {expiryFmt(row.expiryDate)}, leaving {row.projectedUnsoldQty.toLocaleString('en-IN')} worth {inr(row.projectedLoss)} at cost.
                  </p>
                )}
                {row.daysToExpiry <= 0 && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs font-semibold text-danger">This lot has expired. None of it can be sold.</p>}
              </Section>

              {/* How it has actually been selling. */}
              <Section icon={Calendar} title="How this lot has sold" hint={spark.length ? 'Units of this exact lot, by week.' : undefined}>
                {loading ? (
                  <Skeleton className="h-24 w-full rounded-lg" />
                ) : spark.length === 0 ? (
                  <p className="rounded-lg bg-subtle px-3 py-3 text-sm text-muted">
                    No units of this lot have sold recently. That is why its whole quantity counts towards the projected loss.
                  </p>
                ) : (
                  <div className="h-24 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={spark} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                        <XAxis dataKey="weekStart" hide />
                        <Tooltip
                          cursor={{ fill: 'var(--subtle)' }}
                          contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12 }}
                          labelFormatter={(d) => `Week of ${expiryFmt(d)}`}
                          formatter={(v, n) => (n === 'units' ? [`${v} units`, 'Sold'] : [inr(v), 'Value'])}
                        />
                        <Bar dataKey="units" fill="var(--primary)" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Section>

              {/* Where it came from and what it cost. */}
              <Section icon={Package} title="The lot">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  <Fact label="Expires">{expiryFmt(row.expiryDate)}</Fact>
                  <Fact label="Received">{data?.receivedAt ? expiryFmt(data.receivedAt) : '—'}</Fact>
                  <Fact label="Store">{row.branchName || '—'}</Fact>
                  <Fact label="Cost each">{inr(row.purchasePrice)}</Fact>
                  <Fact label="Sells at">{inr(row.sellingPrice)}</Fact>
                  <Fact label="MRP">{inr(row.mrp)}</Fact>
                  <Fact label="Value at cost">{inr(row.costValue)}</Fact>
                  <Fact label="Value at MRP">{inr(row.mrpValue)}</Fact>
                  <Fact label="Reserved">{(data?.reservedQuantity ?? row.reservedQuantity ?? 0).toLocaleString('en-IN')}</Fact>
                  <Fact label="Category">{row.categoryName || 'Not set'}</Fact>
                  <Fact label="HSN">{row.hsnCode || '—'}</Fact>
                  <Fact label="Schedule">{row.scheduleCategory || 'Not recorded'}</Fact>
                </dl>
              </Section>

              <Section icon={Truck} title="Supplier">
                {row.supplierId ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Fact label="Name">{row.supplierName}</Fact>
                    <Fact label="Phone">{data?.supplier?.phone || '—'}</Fact>
                    <Fact label="Recoverable">
                      {row.recoverable ? <span className="font-semibold text-success">Inside the return window</span> : <span className="text-muted">Outside the return window</span>}
                    </Fact>
                    {data?.supplier?.procurement?.paymentTerms && <Fact label="Terms">{data.supplier.procurement.paymentTerms}</Fact>}
                  </dl>
                ) : (
                  <p className="rounded-lg bg-subtle px-3 py-3 text-sm text-muted">
                    No supplier is recorded against this lot, so there is nobody to send it back to. Its value is counted separately from what can be recovered.
                  </p>
                )}
              </Section>

              {/* What has already been done to it. */}
              {(data?.clearance || data?.supplierReturn || data?.disposedAt) && (
                <Section icon={Percent} title="What has been decided">
                  <ul className="space-y-2 text-sm">
                    {data.disposedAt && (
                      <li className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-danger">
                        <Trash2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>
                          Written off {dateTimeFmt(data.disposedAt)} — {data.disposalReason}
                        </span>
                      </li>
                    )}
                    {data.clearance?.flagged && (
                      <li className="rounded-lg bg-subtle px-3 py-2">
                        Marked for clearance at <strong>{data.clearance.discountPercent}%</strong> on {dateTimeFmt(data.clearance.flaggedAt)}
                        {data.clearance.note ? ` — ${data.clearance.note}` : ''}. The selling price was not changed.
                      </li>
                    )}
                    {data.supplierReturn && (
                      <li className="rounded-lg bg-subtle px-3 py-2">
                        Supplier return <strong>{data.supplierReturn.status}</strong> — requested {dateTimeFmt(data.supplierReturn.markedAt)}
                        {data.supplierReturn.settledAt ? `, closed ${dateTimeFmt(data.supplierReturn.settledAt)}` : ''}
                        {data.supplierReturn.note ? ` — ${data.supplierReturn.note}` : ''}
                      </li>
                    )}
                  </ul>
                </Section>
              )}

              {/* The two trails: what happened to the stock, and what people did. */}
              <Section icon={History} title="Stock movements" hint="Every change to this lot's quantity, newest first.">
                {loading ? (
                  <Skeleton className="h-20 w-full rounded-lg" />
                ) : !data?.movements.length ? (
                  <p className="text-sm text-muted">Nothing has moved yet.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {data.movements.slice(0, 12).map((m) => (
                      <li key={m.id} className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5 last:border-0">
                        <span className="min-w-0">
                          <span className="font-medium">{MOVEMENT_WORD[m.type] || m.type}</span>
                          {m.reason && <span className="block truncate text-xs text-muted">{m.reason}</span>}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className={cx('font-semibold tabular-nums', m.quantity > 0 ? 'text-success' : 'text-danger')}>
                            {m.quantity > 0 ? '+' : ''}
                            {m.quantity}
                          </span>
                          <span className="block text-[11px] text-muted">{dateTimeFmt(m.at)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section icon={Building2} title="Who did what" hint="The audit trail for this lot.">
                {loading ? (
                  <Skeleton className="h-16 w-full rounded-lg" />
                ) : !data?.auditTrail.length ? (
                  <p className="text-sm text-muted">Nobody has acted on this lot yet.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {data.auditTrail.slice(0, 12).map((a) => (
                      <li key={a.id} className="border-b border-line pb-1.5 last:border-0">
                        <p>{a.message}</p>
                        <p className="text-[11px] text-muted">
                          {a.by || 'Unknown'} · {dateTimeFmt(a.at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
        </div>

        {/* The actions, always reachable without scrolling back. */}
        {actions.length > 0 && (
          <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
            <Button variant="secondary" size="sm" onClick={() => onAction('transfer', [row])}>
              <ArrowLeftRight className="h-4 w-4" aria-hidden="true" /> Where would this sell?
            </Button>
            {actions.map((a) => (
              <Button key={a} size="sm" variant={a === 'dispose' ? 'danger' : 'secondary'} onClick={() => onAction(a, [row])}>
                {ACTION_LABEL[a]}
              </Button>
            ))}
          </footer>
        )}
      </aside>
    </div>
  );
}
