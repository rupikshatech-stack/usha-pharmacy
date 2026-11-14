import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut, PanelLeftClose, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Logo, cx } from '../common/ui';
import { findNav, placeholderRoutes, visibleNav } from './nav';
import SideTooltip from './SideTooltip';

// The sidebar is always the brand green (#174B3A), in both light and dark mode.
const mark = (
  <span className="grid h-9 w-9 place-items-center rounded-lg bg-white text-side" aria-hidden="true">
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
      <path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z" />
    </svg>
  </span>
);

/*
 * Row geometry: icons sit in a fixed 18px box with 15px padding each side, so the icon is exactly
 * centered in the 48px-wide row of the collapsed (72px) sidebar and never moves when collapsing.
 * Labels simply fade and get clipped by the narrowing sidebar.
 */
const rowBase = 'group relative flex w-full items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg px-[15px] py-2.5 text-[13.5px] font-medium transition-colors';
const rowIdle = 'text-white/70 hover:bg-white/10 hover:text-white';
const rowActive = 'bg-white/15 text-white';
const labelCls = (collapsed) => cx('flex-1 truncate text-left transition-opacity duration-200', collapsed && 'opacity-0');

const IndicatorBar = () => <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-sage" aria-hidden="true" />;
const SoonPill = ({ collapsed }) => (
  <span className={cx('rounded-full bg-white/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white/80 transition-opacity duration-200', collapsed && 'opacity-0')}>Soon</span>
);

function NavItem({ item, collapsed, onNavigate, nested }) {
  const soon = placeholderRoutes.includes(item.to);
  return (
    <SideTooltip label={item.label} enabled={collapsed}>
      <NavLink
        to={item.to}
        end={item.to === '/inventory'} // /inventory/batches, /compounds and /attributes are their own items
        onClick={onNavigate}
        className={({ isActive }) => cx(rowBase, nested && !collapsed && 'py-2 pl-[22px]', isActive ? rowActive : rowIdle)}
      >
        {({ isActive }) => (
          <>
            {isActive && <IndicatorBar />}
            <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            <span className={labelCls(collapsed)}>{item.label}</span>
            {soon && <SoonPill collapsed={collapsed} />}
          </>
        )}
      </NavLink>
    </SideTooltip>
  );
}

function NavGroup({ item, collapsed, open, onToggle, hasActiveChild, onNavigate }) {
  const id = `group-${item.label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div>
      <SideTooltip label={item.label} enabled={collapsed}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open && !collapsed}
          aria-controls={id}
          className={cx(rowBase, hasActiveChild && (collapsed || !open) ? rowActive : rowIdle)}
        >
          {hasActiveChild && (collapsed || !open) && <IndicatorBar />}
          <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          <span className={labelCls(collapsed)}>{item.label}</span>
          <ChevronDown className={cx('h-4 w-4 shrink-0 transition-all duration-200', open && !collapsed && 'rotate-180', collapsed && 'opacity-0')} aria-hidden="true" />
        </button>
      </SideTooltip>
      {/* Smooth expand/collapse of the submenu */}
      <div id={id} className={cx('grid transition-[grid-template-rows] duration-200 ease-out', open && !collapsed ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="overflow-hidden">
          <div className="ml-[22px] space-y-0.5 border-l border-white/10 pb-1 pt-0.5" inert={!(open && !collapsed)}>
            {item.children.map((c) => (
              <NavItem key={c.to} item={c} collapsed={false} nested onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AppSidebar({ collapsed, mobileOpen, onClose, onToggleCollapse }) {
  const { user, logout } = useAuth();
  const items = visibleNav(user);
  const { pathname } = useLocation();
  const [stockOpen, setStockOpen] = useState(() => Boolean(findNav(pathname)?.parent));

  // Opening any Stock Management page (e.g. from a dashboard link) reveals its submenu.
  useEffect(() => {
    if (findNav(pathname)?.parent) setStockOpen(true);
  }, [pathname]);

  // The mobile drawer never shows the collapsed (icon-only) layout.
  const isCollapsed = collapsed && !mobileOpen;

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onClose]);

  return (
    <>
      {mobileOpen && <div className="anim-fade fixed inset-0 z-30 lg:hidden" style={{ background: 'var(--overlay)' }} onClick={onClose} aria-hidden="true" />}
      <aside
        aria-label="Sidebar"
        className={cx(
          // fixed full-height column; only the nav list scrolls
          'fixed inset-y-0 left-0 z-40 flex w-[252px] flex-col bg-side text-white transition-[transform,width] duration-200 ease-out lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'lg:w-[72px]' : 'lg:w-[252px]',
        )}
      >
        {/* Logo section */}
        <div className="relative flex h-16 shrink-0 items-center border-b border-white/10 px-3.5">
          <div className={cx('min-w-0 flex-1 transition-opacity duration-200', isCollapsed && 'pointer-events-none absolute opacity-0')}>
            <Logo onDark className="max-w-[168px]" />
          </div>
          {isCollapsed && <span className="mx-auto">{mark}</span>}
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={onToggleCollapse}
            className={cx('ml-2 hidden h-9 w-9 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white', !collapsed && 'lg:grid')}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="ml-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation — scrolls independently of the page */}
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-3 py-3" aria-label="Main">
          {items.map((item) =>
            item.children ? (
              <NavGroup
                key={item.label}
                item={item}
                collapsed={isCollapsed}
                open={stockOpen}
                hasActiveChild={item.children.some((c) => pathname === c.to || pathname.startsWith(`${c.to}/`))}
                onNavigate={onClose}
                onToggle={() => {
                  // In the icon-only sidebar a group can't show its children, so expand the sidebar first.
                  if (isCollapsed) {
                    onToggleCollapse();
                    setStockOpen(true);
                  } else {
                    setStockOpen((o) => !o);
                  }
                }}
              />
            ) : (
              <NavItem key={item.to} item={item} collapsed={isCollapsed} onNavigate={onClose} />
            ),
          )}
        </nav>

        {/* Log out */}
        <div className="shrink-0 border-t border-white/10 p-3">
          <SideTooltip label="Log Out" enabled={isCollapsed}>
            <button type="button" onClick={logout} className={cx(rowBase, rowIdle)}>
              <LogOut className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              <span className={labelCls(isCollapsed)}>Log Out</span>
            </button>
          </SideTooltip>
        </div>
      </aside>
    </>
  );
}
