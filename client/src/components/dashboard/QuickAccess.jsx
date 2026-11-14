import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, FileText, Pill, Undo2 } from 'lucide-react';
import { Badge, Card } from '../common/ui';

const tiles = [
  { to: '/invoices', title: 'Invoices', hint: 'Transaction history', icon: FileText },
  { to: '/inventory', title: 'Inventory', hint: 'Manage stock levels', icon: Pill },
  { to: '/sales-returns', title: 'Sales Returns', hint: 'Customer refunds', icon: Undo2, soon: true },
  { to: '/reports', title: 'Reports', hint: 'Daily transactions', icon: BarChart3, soon: true },
];

/** Shortcuts to key modules. Modules that aren't built yet are labelled "Coming soon" and open a clear placeholder page. */
export default function QuickAccess() {
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-bold">Quick access</h2>
      <p className="mb-4 text-xs text-muted">Jump to key modules</p>
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        {tiles.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="group flex items-center gap-3 rounded-xl border border-line p-3 transition-colors hover:border-primary hover:bg-sage/40"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sage text-sage-ink">
              <t.icon className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold">{t.title}</span>
                {t.soon && <Badge tone="warning">Coming soon</Badge>}
              </span>
              <span className="block truncate text-xs text-muted">{t.hint}</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted/50 transition-colors group-hover:text-primary" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </Card>
  );
}
