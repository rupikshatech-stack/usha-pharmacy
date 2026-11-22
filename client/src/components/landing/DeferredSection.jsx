import { Suspense, useEffect, useState } from 'react';

/**
 * Mounts a below-the-fold landing section only after the page has loaded and the browser is idle, so its code
 * (the WebGL carousel, the charts, gsap) is not on the path to the first paint.
 *
 * Until then a placeholder with the SAME id and a reserved height stands in, so in-page links still land and the
 * sections after it start close to where they will end up. The capsule's scroll poses are anchored to those later
 * sections, so once the real section is in place one `resize` event tells it (and ScrollTrigger) to measure again.
 *
 *   component   a React.lazy component, declared once at module level
 *   id          the id the real section carries, kept on the placeholder
 *   className   sets the placeholder's min-height; viewport units match how these sections size themselves
 */
function Settled() {
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, []);
  return null;
}

export default function DeferredSection({ component: Section, id, className = '' }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let handle = 0;
    const go = () => {
      if (cancelled) return;
      if ('requestIdleCallback' in window) handle = window.requestIdleCallback(() => !cancelled && setReady(true), { timeout: 2500 });
      else handle = window.setTimeout(() => setReady(true), 800);
    };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener('load', go);
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  const placeholder = <div id={id} className={className} aria-hidden="true" />;
  if (!ready) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <Section />
      <Settled />
    </Suspense>
  );
}
