import { ChevronDown, LogOut, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Dropdown, MenuItem } from '../common/Dropdown';

/** Avatar + organization name + role label, opening a menu with account details and Log Out. */
export default function UserProfileMenu() {
  const { user, logout } = useAuth();
  const org = user.organization?.name;

  return (
    <Dropdown
      width="w-64"
      label="Account"
      trigger={({ toggle, props }) => (
        <button
          {...props}
          onClick={toggle}
          aria-label={`Account menu for ${user.name}, ${org}`}
          className="flex items-center gap-2.5 rounded-lg p-1 pr-2 transition-colors hover:bg-subtle"
        >
          <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-bold text-on-primary" aria-hidden="true">
            {user.name?.[0]?.toUpperCase()}
          </span>
          <span className="hidden max-w-[11rem] text-left leading-tight md:block">
            <span className="block truncate text-[13px] font-bold">{org}</span>
            <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-muted">{user.role}</span>
          </span>
          <ChevronDown className="hidden h-4 w-4 text-muted md:block" aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="space-y-1 border-b border-line px-4 py-3">
            <div className="font-semibold">{user.name}</div>
            <div className="text-xs text-muted">{org}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="truncate">{user.email}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {user.role}
            </div>
          </div>
          <div className="py-1">
            <MenuItem
              icon={LogOut}
              danger
              onClick={() => {
                close();
                logout();
              }}
            >
              Log Out
            </MenuItem>
          </div>
        </div>
      )}
    </Dropdown>
  );
}
