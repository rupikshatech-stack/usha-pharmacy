/**
 * The hero's dark atmosphere, ported from the "elegant dark pattern" background (21st.dev) to plain JSX.
 *
 * A lit corner falling off into black, five skewed streaks of light, and a faint dot grid. Differences from the
 * original, on purpose: the streaks are the brand emerald instead of cyan, the black is the deep apothecary forest
 * the footer already uses, and the grain is an inline SVG rather than a PNG hot-linked from a third-party CDN
 * (an external image on the landing page is a request to someone else's server on every visit).
 *
 * It fills whatever positions it: BackdropLayers gives it the whole viewport and fades it as the hero scrolls away.
 * Static and decorative, so it is aria-hidden and has no motion to reduce.
 */

const STREAK = 'linear-gradient(rgb(72, 214, 168) 0%, rgba(72, 214, 168, 0) 100%)';

// each streak is the same ramp of light, masked into a different set of vertical bands, then skewed
const MASKS = [
  'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 20%, rgba(0,0,0,0) 36%, rgb(0,0,0) 55%, rgba(0,0,0,0.13) 67%, rgb(0,0,0) 78%, rgba(0,0,0,0) 97%)',
  'linear-gradient(90deg, rgba(0,0,0,0) 11%, rgb(0,0,0) 25%, rgba(0,0,0,0.55) 41%, rgba(0,0,0,0.13) 67%, rgb(0,0,0) 78%, rgba(0,0,0,0) 97%)',
  'linear-gradient(90deg, rgba(0,0,0,0) 9%, rgb(0,0,0) 20%, rgba(0,0,0,0.55) 28%, rgba(0,0,0,0.424) 40%, rgb(0,0,0) 48%, rgba(0,0,0,0.267) 54%, rgba(0,0,0,0.13) 78%, rgb(0,0,0) 88%, rgba(0,0,0,0) 97%)',
  'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 17%, rgba(0,0,0,0.55) 26%, rgb(0,0,0) 35%, rgba(0,0,0,0) 47%, rgba(0,0,0,0.13) 69%, rgb(0,0,0) 79%, rgba(0,0,0,0) 97%)',
  'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 20%, rgba(0,0,0,0.55) 27%, rgb(0,0,0) 42%, rgba(0,0,0,0) 48%, rgba(0,0,0,0.13) 67%, rgb(0,0,0) 74%, rgb(0,0,0) 82%, rgba(0,0,0,0.47) 88%, rgba(0,0,0,0) 97%)',
];

const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

export default function DarkPattern({ className = '' }) {
  return (
    <div className={`absolute inset-0 overflow-hidden ${className}`} style={{ backgroundColor: '#06110d' }} aria-hidden="true">
      {/* the lit corner, fading out toward the far side */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(100% 100% at 0% 0%, rgb(38, 78, 63) 0%, rgb(6, 17, 13) 100%)',
          WebkitMask: 'radial-gradient(125% 100% at 0% 0%, rgb(0,0,0) 0%, rgba(0,0,0,0.224) 88.2883%, rgba(0,0,0,0) 100%)',
          mask: 'radial-gradient(125% 100% at 0% 0%, rgb(0,0,0) 0%, rgba(0,0,0,0.224) 88.2883%, rgba(0,0,0,0) 100%)',
        }}
      >
        {MASKS.map((mask, i) => (
          <div
            key={i}
            className="absolute inset-0"
            style={{ opacity: 0.2, background: STREAK, WebkitMask: mask, mask, transform: 'skewX(45deg)' }}
          />
        ))}
      </div>

      <div className="absolute inset-0" style={{ opacity: 0.05, backgroundImage: GRAIN, backgroundSize: '160px 160px' }} />
      <div
        className="absolute inset-0"
        style={{ opacity: 0.2, backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0)', backgroundSize: '20px 20px' }}
      />
    </div>
  );
}
