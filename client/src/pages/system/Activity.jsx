import { useState } from 'react';
import { History } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { dateTimeFmt } from '../../utils/format';
import { Card, EmptyState, ErrorState, PageHeader, Pagination } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';

const LIMIT = 20;
const columns = [
  { key: 'when', header: 'When', render: (a) => <span className="whitespace-nowrap text-muted">{dateTimeFmt(a.createdAt)}</span> },
  { key: 'user', header: 'User', render: (a) => a.userName || '—' },
  { key: 'message', header: 'Event', render: (a) => a.message },
];

export default function Activity() {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useFetch('/activity', { page, limit: LIMIT });

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader title="Activity Log" description="Audit trail of important operations in your workspace." />
      <Card>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <DataTable columns={columns} rows={data?.items || []} rowKey={(a) => a._id} loading={loading && !data} minWidth={560} empty={<EmptyState icon={History} title="No activity yet" />} />
            {data && data.total > 0 && <Pagination page={data.page} pages={data.pages} total={data.total} limit={LIMIT} onPage={setPage} />}
          </>
        )}
      </Card>
    </div>
  );
}
