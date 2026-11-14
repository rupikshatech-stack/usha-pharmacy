import { useId, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Tooltip for the collapsed sidebar. It is rendered in a portal with fixed positioning because the
 * sidebar's scroll container would clip a normal absolutely-positioned tooltip.
 * It appears on hover and on keyboard focus, and is disabled when the sidebar is expanded.
 */
export default function SideTooltip({ label, enabled, children }) {
  const [pos, setPos] = useState(null);
  const id = useId();

  const show = (e) => {
    if (!enabled) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ top: r.top + r.height / 2, left: r.right + 10 });
  };
  const hide = () => setPos(null);

  return (
    <div onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} aria-describedby={pos ? id : undefined}>
      {children}
      {enabled &&
        pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="anim-fade pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-md bg-[#0b1f18] px-2.5 py-1.5 text-xs font-semibold text-white shadow-pop"
            style={{ top: pos.top, left: pos.left }}
          >
            {label}
          </div>,
          document.body,
        )}
    </div>
  );
}
