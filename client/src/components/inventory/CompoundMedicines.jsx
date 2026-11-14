import { useState } from 'react';
import { Link2, Unlink } from 'lucide-react';
import toast from 'react-hot-toast';
import { compoundService } from '../../services/catalogService';
import { useFetch } from '../../hooks/useFetch';
import { Badge, ErrorState, Modal, Skeleton, StatusBadge } from '../common/ui';
import MedicinePicker from './MedicinePicker';

/** The medicines linked to a compound: see them, link more (search and add), unlink. */
export default function CompoundMedicines({ compound, canWrite, onChanged, onClose }) {
  const { data, loading, error, reload } = useFetch(`/compounds/${compound._id}`);
  const [busy, setBusy] = useState(false);
  const archived = (data || compound).status !== 'active';

  const run = async (fn, success) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      reload();
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title={`Medicines using ${compound.compoundName}`} description={compound.composition || 'Link medicines to this compound so they can be found and reported together.'} onClose={onClose}>
      <div className="space-y-4">
        {canWrite && (
          <div>
            <MedicinePicker multiple label="Link a medicine" className="" placeholder={archived ? 'Archived compounds cannot be linked' : 'Search a medicine to link…'} exclude={(data?.medicines || []).map((m) => m._id)} onChange={(m) => !archived && !busy && run(() => compoundService.link(compound._id, [m._id]), `${m.medicineName} linked`)} />
            {archived && <p className="mt-1 text-xs text-warning">This compound is archived. Reactivate it to link more medicines.</p>}
            <p className="mt-1 text-xs text-muted">A medicine has one compound; linking moves it here from its previous one.</p>
          </div>
        )}

        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !data ? (
          <Skeleton className="h-24 w-full" />
        ) : data.medicines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No medicines are linked to this compound yet.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {data.medicines.map((m) => (
              <li key={m._id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{m.medicineName}</span>
                    {m.isActive === false && <StatusBadge status="archived" />}
                  </div>
                  <div className="text-xs text-muted">{[m.strength, m.dosageForm, m.manufacturer].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => compoundService.unlink(compound._id, m._id), `${m.medicineName} unlinked`)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-subtle hover:text-danger disabled:opacity-50"
                    aria-label={`Unlink ${m.medicineName}`}
                  >
                    <Unlink className="h-3.5 w-3.5" /> Unlink
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          {data ? <Badge tone="neutral">{data.medicineCount} linked</Badge> : null}
          You can also choose the compound in the medicine form (“Salt / compound”).
        </p>
      </div>
    </Modal>
  );
}
