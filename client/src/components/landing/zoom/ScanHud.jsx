/*
 * The scan HUD drawn over the barcode. Every stroke uses pathLength="1", so one shared `--draw` custom property
 * (1 -> 0) animates stroke-dashoffset across all of them regardless of their real length. Everything sits inside
 * a clip circle and blends with `screen`, so it adds light to the photo rather than covering it.
 */
export default function ScanHud({ className = '' }) {
  const ticks = Array.from({ length: 24 }, (_, i) => i);
  return (
    <svg className={`zs-hud ${className}`} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="zs-clip">
          <circle cx="100" cy="100" r="78" />
        </clipPath>
        <linearGradient id="zs-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#d8ccff" />
          <stop offset="100%" stopColor="#8f78ff" />
        </linearGradient>
      </defs>

      <g clipPath="url(#zs-clip)">
        {/* mesh */}
        <g className="zs-hud__mesh">
          {Array.from({ length: 13 }, (_, i) => (
            <g key={i}>
              <line x1="22" y1={22 + i * 13} x2="178" y2={22 + i * 13} />
              <line x1={22 + i * 13} y1="22" x2={22 + i * 13} y2="178" />
            </g>
          ))}
        </g>
        {/* the travelling scan line */}
        <rect className="zs-hud__beam" x="22" y="0" width="156" height="3" rx="1.5" />
      </g>

      {/* arcs that draw themselves */}
      <circle className="zs-hud__arc" pathLength="1" cx="100" cy="100" r="78" />
      <path className="zs-hud__arc zs-hud__arc--b" pathLength="1" d="M100 32 A68 68 0 0 1 168 100" />
      <path className="zs-hud__arc zs-hud__arc--c" pathLength="1" d="M100 168 A68 68 0 0 1 32 100" />

      {/* corner brackets framing the code */}
      {[[40, 62, 1, 1], [160, 62, -1, 1], [40, 138, 1, -1], [160, 138, -1, -1]].map(([x, y, sx, sy]) => (
        <path
          key={`${x}-${y}`}
          className="zs-hud__bracket"
          pathLength="1"
          d={`M${x} ${y + 18 * sy} L${x} ${y} L${x + 20 * sx} ${y}`}
        />
      ))}

      {/* rotating tick ring */}
      <g className="zs-hud__ring">
        {ticks.map((i) => (
          <line key={i} x1="100" y1="14" x2="100" y2={i % 6 === 0 ? 24 : 19} transform={`rotate(${i * 15} 100 100)`} />
        ))}
      </g>

      <text className="zs-hud__label" x="100" y="192" textAnchor="middle">BATCH PC4410 · EXP 03 / 2027</text>
    </svg>
  );
}
