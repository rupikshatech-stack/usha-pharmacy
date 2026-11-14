import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { cx } from '../common/ui';
import { findNav, pageTitle, subPages } from './nav';

/** Organization › (group ›) current page, e.g. "Usha Pharmacy › Stock Management › All Inventory". */
export default function Breadcrumbs() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const found = findNav(pathname);
  const sub = subPages.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));

  // A page inside a page names its parent. When that parent sits in a menu group, the GROUP is the useful crumb:
  // "Business Analytics › Sales Report" tells you where you are; "Overview › Sales Report" does not.
  const parentNav = sub ? findNav(sub.parent) : null;
  const trail = sub
    ? [
      { label: user.organization?.name, to: '/dashboard' },
      { label: parentNav?.parent?.label || parentNav?.item.label || 'Page', to: sub.parent },
      { label: sub.label },
    ]
    : [
    { label: user.organization?.name, to: '/dashboard' },
    ...(found?.parent ? [{ label: found.parent.label }] : []),
    ...(found?.item.to === '/dashboard' ? [] : [{ label: found?.item.label || pageTitle(pathname) || 'Page' }]),
  ];
  // On the dashboard itself the organization crumb is the current page; show "Dashboard" as the leaf.
  if (!sub && found?.item.to === '/dashboard') trail.push({ label: 'Dashboard' });

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-[13px]">
        {trail.map((t, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={`${t.label}-${i}`} className={cx('flex min-w-0 items-center gap-1.5', !last && i < trail.length - 2 && 'hidden md:flex')}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted/60" aria-hidden="true" />}
              {t.to && !last ? (
                <Link to={t.to} className="truncate text-muted hover:text-ink">
                  {t.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cx('truncate', last ? 'font-semibold' : 'text-muted')}>
                  {t.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
