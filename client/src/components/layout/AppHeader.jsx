import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleHelp, Maximize, Menu, Minimize, Moon, PanelLeftOpen, Search, Sun } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { getDisplayTimezone } from '../../utils/format';
import Breadcrumbs from './Breadcrumbs';
import CreditBalance from './CreditBalance';
import NotificationDropdown from './NotificationDropdown';
import UserProfileMenu from './UserProfileMenu';
import { Dropdown } from '../common/Dropdown';
import { IconButton, cx, inputCls } from '../common/ui';

const shortcuts = [
  ['Ctrl + K', 'Focus global search'],
  ['F1 or /', 'Search at the Selling Point'],
  ['F2 / F5', 'Save / Save & print bill'],
  ['F6 / F7', 'Hold bill / Held bills'],
  ['Esc', 'Close dialogs, clear bill'],
];

/** Live clock + current date. Only this small component re-renders every second. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="hidden text-right leading-tight sm:block" role="timer" aria-label="Current time">
      <div className="text-[13px] font-bold tabular-nums">{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: getDisplayTimezone() })}</div>
      <div className="hidden text-[10.5px] font-semibold uppercase tracking-wider text-muted md:block">
        {now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: getDisplayTimezone() })}
      </div>
    </div>
  );
}

function FullscreenButton() {
  const [full, setFull] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  if (!document.documentElement.requestFullscreen) return null; // e.g. iOS Safari

  const toggle = () => {
    const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    p?.catch(() => {}); // the browser may refuse (e.g. not triggered by a user gesture)
  };
  return (
    <IconButton label={full ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={toggle} className="hidden sm:grid">
      {full ? <Minimize className="h-[18px] w-[18px]" /> : <Maximize className="h-[18px] w-[18px]" />}
    </IconButton>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    navigate(`/inventory?search=${encodeURIComponent(term)}`);
    setQ('');
    ref.current?.blur();
  };

  return (
    <form onSubmit={submit} role="search" className="relative hidden w-full max-w-xs xl:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search medicines"
        placeholder="Search medicines…"
        className={cx(inputCls, 'h-9 bg-app pl-9 pr-14 text-[13px]')}
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line bg-card px-1.5 py-0.5 text-[10px] font-semibold text-muted">Ctrl K</kbd>
    </form>
  );
}

export default function AppHeader({ collapsed, onOpenMobile, onToggleCollapse }) {
  const { theme, toggle } = useTheme();
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line bg-card px-3 sm:gap-3 sm:px-5">
      <IconButton label="Open menu" onClick={onOpenMobile} className="lg:hidden">
        <Menu className="h-5 w-5" />
      </IconButton>
      {collapsed && (
        <IconButton label="Expand sidebar" onClick={onToggleCollapse} className="hidden lg:grid">
          <PanelLeftOpen className="h-[18px] w-[18px]" />
        </IconButton>
      )}

      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>

      <GlobalSearch />

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <CreditBalance />
        <span className="mx-1.5 hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
        <Clock />
        <span className="mx-1.5 hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
        <FullscreenButton />
        <IconButton label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggle}>
          {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </IconButton>
        <NotificationDropdown />
        <Dropdown
          width="w-72"
          label="Help"
          trigger={({ toggle: t, props }) => (
            <IconButton label="Help and shortcuts" {...props} onClick={t} className="hidden lg:grid">
              <CircleHelp className="h-[18px] w-[18px]" />
            </IconButton>
          )}
        >
          <div className="p-4">
            <p className="text-sm font-bold">Keyboard shortcuts</p>
            <dl className="mt-2 space-y-1.5">
              {shortcuts.map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
                  <dt className="text-muted">{d}</dt>
                  <dd>
                    <kbd className="rounded border border-line bg-subtle px-1.5 py-0.5 text-[11px] font-semibold">{k}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Dropdown>
        <span className="mx-1.5 hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
        <UserProfileMenu />
      </div>
    </header>
  );
}
