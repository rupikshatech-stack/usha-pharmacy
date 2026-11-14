import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ShieldBan, ShieldCheck, Users } from 'lucide-react';
import { Card, EmptyState, cx } from '../../components/common/ui';
import { useAuth } from '../../context/AuthContext';
import { userCan } from '../../components/layout/nav';
import RolesTab from './RolesTab';
import UsersTab from './UsersTab';

const TABS = [
  { key: 'roles', label: 'Roles', icon: ShieldCheck },
  { key: 'users', label: 'Users', icon: Users },
];

/**
 * Roles and users: who works here and what each of them may do.
 *
 * The two live on one screen because they are one question asked from two ends - a role nobody holds is a draft,
 * and a user without a role cannot sign in to anything. The tab is in the URL (`/roles/users`) so it can be linked
 * to and the Back button behaves.
 *
 * There is no page-level unsaved guard here, unlike Settings: editing happens inside a dialog, and closing a dialog
 * is already a deliberate act with its own Discard. The dialogs use the same `useDirtyForm` and the same save bar,
 * so what "unsaved" means is identical across the two modules.
 */
export default function RolesAndUsers() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const active = TABS.find((t) => t.key === tab);

  if (!active) return <Navigate to="/roles/roles" replace />;

  /**
   * Somebody without `users:manage` reaching this URL directly - typed, bookmarked, or followed from a link somebody
   * sent them. The sidebar link is already hidden from them, so this is the back door.
   *
   * The server refuses them either way; what this fixes is the SCREEN pretending otherwise. Without it they get the
   * heading, the tabs and two tables that sit empty forever, which reads as "this feature is broken" rather than
   * "this is not for you". It asks the same question the sidebar asks, through the same `userCan` helper, so the two
   * cannot drift apart - and it is a courtesy, never the enforcement: every one of these endpoints checks
   * `users:manage` for itself, and nothing here is reachable by editing the permission list in the browser.
   */
  if (!userCan(user, 'users:manage')) {
    return (
      <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
        <Card className="rounded-2xl">
          <EmptyState
            icon={ShieldBan}
            title="You don't have access to this page"
            hint="Roles & Users is for administrators. Ask an administrator for the “Manage users and roles” permission if you need it."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Administration</p>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ShieldCheck className="h-6 w-6 text-muted" aria-hidden="true" /> Roles &amp; Users
        </h1>
        <p className="mt-1 text-sm text-muted">Who works here, what each role may do, and which stores they work in.</p>
      </header>

      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-subtle p-1" aria-label="Administration sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => navigate(`/roles/${t.key}`)}
              aria-current={isActive ? 'page' : undefined}
              className={cx(
                'inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors',
                isActive ? 'bg-card text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === 'roles' ? <RolesTab /> : <UsersTab />}
    </div>
  );
}
