/**
 * Decorative background motion for a section: drifting gradient blobs and, optionally, a floating glass panel.
 * Purely visual (aria-hidden, no pointer events). The parent must be `relative overflow-hidden`.
 */
export default function Backdrop({ glass = false, className = '' }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 -z-0 overflow-hidden ${className}`}>
      <div className="lp-blob lp-blob--a -left-24 -top-32 h-[22rem] w-[22rem] md:-left-40 md:-top-48 md:h-[44rem] md:w-[44rem]" />
      <div className="lp-blob lp-blob--b -right-40 top-1/4 h-[40rem] w-[40rem]" />
      {glass && <div className="lp-glass -right-10 top-24 hidden h-64 w-48 md:block lg:-right-6 lg:h-80 lg:w-60" />}
    </div>
  );
}
