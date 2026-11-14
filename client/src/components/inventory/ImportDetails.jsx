import { dateTimeFmt } from '../../utils/format';
import { useFetch } from '../../hooks/useFetch';
import { Skeleton, ErrorState, Modal, StatusBadge } from '../common/ui';
import ImportRowsTable from './ImportRowsTable';
import ImportSummary from './ImportSummary';

/** A past import: its summary and what happened to every row. */
export default function ImportDetails({ id, onClose }) {
  const { data: job, loading, error, reload } = useFetch(`/import/inventory/${id}`);
  const finished = job && !['previewed', 'cancelled'].includes(job.status);

  return (
    <Modal wide title={job ? job.fileName : 'Import'} description={job ? `Uploaded ${dateTimeFmt(job.createdAt)}` : undefined} onClose={onClose}>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading || !job ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge status={job.status} />
            {finished && (
              <span className="text-muted">
                {job.medicinesCreated} medicine{job.medicinesCreated === 1 ? '' : 's'} and {job.batchesCreated} batch{job.batchesCreated === 1 ? '' : 'es'} created
              </span>
            )}
          </div>
          {job.error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{job.error}</p>}
          <ImportSummary summary={job.summary} finished={finished} />
          <div className="overflow-hidden rounded-xl border border-line">
            <ImportRowsTable rows={job.rows} fileLabel={job.fileName} />
          </div>
        </div>
      )}
    </Modal>
  );
}
