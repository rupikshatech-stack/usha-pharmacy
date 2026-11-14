import { useState } from 'react';
import { Plus, SlidersHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { medicineService } from '../../services/medicineService';
import { stockService } from '../../services/stockService';
import { dateTimeFmt, expiryFmt, inr } from '../../utils/format';
import { useFetch } from '../../hooks/useFetch';
import { Badge, Button, ErrorState, Input, Modal, Select, Skeleton } from '../common/ui';

const blankBatch = { batchNumber: '', manufacturingDate: '', expiryDate: '', purchasePrice: '', mrp: '', sellingPrice: '', initialQuantity: '' };

function validateBatch(b) {
  const e = {};
  if (!b.batchNumber.trim()) e.batchNumber = 'Required';
  if (!b.expiryDate) e.expiryDate = 'Required';
  else if (new Date(b.expiryDate) <= new Date()) e.expiryDate = 'Must be a future date';
  if (b.manufacturingDate && b.expiryDate && b.manufacturingDate >= b.expiryDate) e.manufacturingDate = 'Must be before expiry';
  if (!(Number(b.initialQuantity) >= 1) || !Number.isInteger(Number(b.initialQuantity))) e.initialQuantity = 'Whole number ≥ 1';
  if (b.mrp === '' || Number(b.mrp) < 0) e.mrp = 'Required';
  if (b.sellingPrice === '' || Number(b.sellingPrice) < 0) e.sellingPrice = 'Required';
  else if (b.mrp !== '' && Number(b.sellingPrice) > Number(b.mrp)) e.sellingPrice = 'Cannot exceed MRP';
  return e;
}

const statusTone = { active: 'success', quarantined: 'warning', recalled: 'danger', archived: 'neutral' };
const movementLabel = { PURCHASE: 'Received', SALE: 'Sold', SALE_RETURN: 'Returned', ADJUSTMENT: 'Adjusted', WRITE_OFF: 'Written off', OPENING: 'Opening', TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out' };

export default function MedicineDetails({ id, startWithBatch, onClose, onChanged }) {
  const { data, loading, error, reload } = useFetch(`/inventory/${id}`);
  const history = useFetch('/stock/movements', { medicineId: id, limit: 8 });

  const [batch, setBatch] = useState(blankBatch);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  const [adj, setAdj] = useState({ batchId: '', quantity: '', reason: '' });
  const [adjBusy, setAdjBusy] = useState(false);

  const errors = validateBatch(batch);
  const set = (k) => (e) => setBatch((b) => ({ ...b, [k]: e.target.value }));
  const f = (k, label, extra) => <Input label={label} value={batch[k]} onChange={set(k)} error={submitted ? errors[k] : undefined} {...extra} />;

  const refresh = () => {
    reload();
    history.reload();
    onChanged();
  };

  const addBatch = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const body = { ...batch };
      if (!body.manufacturingDate) delete body.manufacturingDate;
      await medicineService.addBatch(id, body);
      toast.success('Batch received');
      setBatch(blankBatch);
      setSubmitted(false);
      refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const adjust = async (e) => {
    e.preventDefault();
    const quantity = Number(adj.quantity);
    if (!adj.batchId) return toast.error('Choose a batch');
    if (!Number.isInteger(quantity) || quantity === 0) return toast.error('Enter a whole number, not zero (use a minus sign to remove stock)');
    if (adj.reason.trim().length < 3) return toast.error('Give a reason for the adjustment');
    setAdjBusy(true);
    try {
      await stockService.adjust({ batchId: adj.batchId, quantity, reason: adj.reason.trim(), type: quantity < 0 && /write.?off|expired|damag/i.test(adj.reason) ? 'WRITE_OFF' : 'ADJUSTMENT' });
      toast.success('Stock adjusted');
      setAdj({ batchId: '', quantity: '', reason: '' });
      refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAdjBusy(false);
    }
  };

  const details =
    data && [
      ['Generic name', data.genericName],
      ['Salt / composition', data.salt],
      ['Compound', data.compoundName],
      ['Manufacturer', data.manufacturer],
      ['Category', data.categoryName],
      ['Dosage form', data.dosageForm],
      ['Strength', data.strength],
      ['Pack size', data.packSize],
      ['Unit', data.unit],
      ['Barcode', data.barcode],
      ['SKU', data.sku],
      ['HSN code', data.hsnCode],
      ['GST', `${data.gstPercentage}%`],
      ['Reorder level', data.reorderLevel],
      ['Status', data.isActive ? 'Active' : 'Discontinued'],
      ...(data.attributes || []).map((a) => [a.key, a.value]),
    ];

  const adjustable = data?.batches.filter((b) => b.status !== 'archived') || [];

  return (
    <Modal wide title={data?.medicineName || 'Medicine'} description="Product details and batch stock" onClose={onClose}>
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="space-y-5">
          {data.description && <p className="rounded-lg bg-subtle px-3 py-2 text-sm text-muted">{data.description}</p>}
          <dl className="grid gap-x-8 sm:grid-cols-2">
            {details.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-line py-2 text-sm">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right font-medium">{v || '—'}</dd>
              </div>
            ))}
          </dl>

          <div>
            <h3 className="mb-2 text-sm font-bold">Batches</h3>
            {data.batches.length ? (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['Batch', 'Expiry', 'On hand', 'Reserved', 'Sellable', 'MRP', 'Selling'].map((h) => (
                        <th key={h} className="px-4 py-2 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.batches.map((b) => (
                      <tr key={b._id} className="border-t border-line">
                        <td className="px-4 py-2">
                          <div className="font-medium">{b.batchNumber}</div>
                          {b.status !== 'active' && <Badge tone={statusTone[b.status]}>{b.status}</Badge>}
                        </td>
                        <td className="px-4 py-2">
                          {expiryFmt(b.expiryDate)} {b.isExpired && <Badge tone="danger">Expired</Badge>}
                        </td>
                        <td className="px-4 py-2 tabular-nums">{b.availableQuantity}</td>
                        <td className="px-4 py-2 tabular-nums text-muted">{b.reservedQuantity}</td>
                        <td className="px-4 py-2 font-semibold tabular-nums">{b.sellableQuantity}</td>
                        <td className="px-4 py-2 tabular-nums">{inr(b.mrp)}</td>
                        <td className="px-4 py-2 tabular-nums">{inr(b.sellingPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted">No batches yet — receive the first one below to put this medicine in stock.</p>
            )}
            <p className="mt-1.5 text-xs text-muted">Expired, quarantined, recalled and reserved units are never sellable. Batches are permanent records and can't be deleted.</p>
          </div>

          <form onSubmit={addBatch} noValidate className="rounded-xl border border-line p-4">
            <h3 className="mb-3 text-sm font-bold">Receive a batch</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {f('batchNumber', 'Batch number', { required: true, autoFocus: startWithBatch })}
              {f('expiryDate', 'Expiry date', { type: 'date', required: true })}
              {f('manufacturingDate', 'Manufacturing date', { type: 'date' })}
              {f('initialQuantity', 'Quantity received', { type: 'number', min: '1', required: true })}
              {f('purchasePrice', 'Purchase price', { type: 'number', min: '0', step: '0.01' })}
              {f('mrp', 'MRP', { type: 'number', min: '0', step: '0.01', required: true })}
              {f('sellingPrice', 'Selling price', { type: 'number', min: '0', step: '0.01', required: true })}
            </div>
            <div className="mt-3 flex justify-end">
              <Button type="submit" loading={busy} disabled={!data.isActive}>
                <Plus className="h-4 w-4" /> Receive batch
              </Button>
            </div>
            {!data.isActive && <p className="mt-2 text-xs text-warning">This medicine is discontinued; reactivate it to receive stock.</p>}
          </form>

          {adjustable.length > 0 && (
            <form onSubmit={adjust} className="rounded-xl border border-line p-4">
              <h3 className="mb-1 text-sm font-bold">Adjust stock</h3>
              <p className="mb-3 text-xs text-muted">For stock-take corrections, damage or expiry write-offs. Every adjustment is recorded in the stock history.</p>
              <div className="grid gap-3 sm:grid-cols-[1.2fr_0.7fr_1.6fr_auto] sm:items-end">
                <Select label="Batch" value={adj.batchId} onChange={(e) => setAdj({ ...adj, batchId: e.target.value })}>
                  <option value="">Select…</option>
                  {adjustable.map((b) => (
                    <option key={b._id} value={b._id}>
                      {b.batchNumber} ({b.availableQuantity} on hand)
                    </option>
                  ))}
                </Select>
                <Input label="Quantity (+/−)" type="number" step="1" placeholder="-3" value={adj.quantity} onChange={(e) => setAdj({ ...adj, quantity: e.target.value })} />
                <Input label="Reason" placeholder="e.g. Damaged in storage" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
                <Button type="submit" variant="secondary" loading={adjBusy}>
                  <SlidersHorizontal className="h-4 w-4" /> Adjust
                </Button>
              </div>
            </form>
          )}

          <div>
            <h3 className="mb-2 text-sm font-bold">Stock history</h3>
            {history.error ? (
              <p className="text-sm text-danger">{history.error}</p>
            ) : !history.data ? (
              <Skeleton className="h-16 w-full" />
            ) : history.data.items.length ? (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['When', 'Batch', 'Change', 'Balance', 'Note'].map((h) => (
                        <th key={h} className="px-4 py-2 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.items.map((e) => (
                      <tr key={e._id} className="border-t border-line">
                        <td className="whitespace-nowrap px-4 py-2 text-muted">{dateTimeFmt(e.createdAt)}</td>
                        <td className="px-4 py-2">{e.batchNumber}</td>
                        <td className={`px-4 py-2 font-semibold tabular-nums ${e.quantity > 0 ? 'text-success' : 'text-danger'}`}>
                          {e.quantity > 0 ? '+' : ''}
                          {e.quantity} <span className="text-xs font-normal text-muted">{movementLabel[e.type] || e.type}</span>
                        </td>
                        <td className="px-4 py-2 tabular-nums">{e.balanceAfter ?? '—'}</td>
                        <td className="px-4 py-2 text-muted">{e.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted">No stock movements yet.</p>
            )}
            <p className="mt-1.5 text-xs text-muted">The stock history is permanent: entries can't be edited or deleted, only corrected with a new entry.</p>
          </div>
        </div>
      )}
    </Modal>
  );
}
