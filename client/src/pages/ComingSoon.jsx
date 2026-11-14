import { Link } from 'react-router-dom';
import { Construction } from 'lucide-react';
import { Badge, Button, Card, PageHeader } from '../components/common/ui';

/** Placeholder for modules that are in the navigation but not built yet. */
export default function ComingSoon({ title }) {
  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader title={title} description="This module is part of a later phase." actions={<Badge tone="warning" dot>Coming soon</Badge>} />
      <Card>
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-sage text-sage-ink">
            <Construction className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="text-lg font-bold">{title} is coming soon</h2>
          <p className="max-w-md text-sm text-muted">We're still building this part of Usha Pharmacy. Everything else in your workspace works as normal.</p>
          <Link to="/dashboard" className="mt-2">
            <Button variant="secondary">Back to dashboard</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
