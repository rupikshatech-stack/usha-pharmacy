/*
 * The preview drawings for the audience index: one small, flat illustration per row, 240 by 160, in the site's
 * forest and the canopy's autumn. Drawn here so nothing loads.
 */

const F = '#174b3a'; // forest
const S = '#f1b24a'; // autumn soft
const A = '#a5451a'; // autumn accent
const P = '#f7f6f2'; // porcelain
const L = 'rgba(17,34,29,.14)'; // line

function Bill() {
  return (
    <svg viewBox="0 0 240 160" aria-hidden="true">
      <rect width="240" height="160" fill="#efe6d4" />
      <rect x="64" y="14" width="112" height="140" rx="10" fill={P} />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x="78" y={34 + i * 22} width={i === 1 ? 46 : 54} height="7" rx="3.5" fill={L} />
          <rect x="140" y={34 + i * 22} width="22" height="7" rx="3.5" fill={L} />
        </g>
      ))}
      <rect x="78" y="104" width="84" height="1.5" fill={L} />
      <rect x="78" y="112" width="30" height="8" rx="4" fill={F} opacity=".35" />
      <rect x="132" y="111" width="30" height="10" rx="5" fill={F} />
      <rect x="150" y="128" width="58" height="22" rx="11" fill={F} />
      <path d="M164 139l5 5 9-10" fill="none" stroke={S} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="182" y="136" width="18" height="6" rx="3" fill={P} opacity=".8" />
    </svg>
  );
}

function Branches() {
  const stores = [
    [52, 52],
    [188, 46],
    [120, 120],
  ];
  return (
    <svg viewBox="0 0 240 160" aria-hidden="true">
      <rect width="240" height="160" fill="#dfe9e3" />
      <path d="M68 58 Q120 20 172 52" fill="none" stroke={F} strokeWidth="2.4" strokeDasharray="5 6" strokeLinecap="round" />
      <path d="M60 72 Q78 118 104 120" fill="none" stroke={F} strokeWidth="2.4" strokeDasharray="5 6" strokeLinecap="round" />
      <path d="M180 64 Q170 112 136 118" fill="none" stroke={A} strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="137" cy="118" r="4" fill={A} />
      {stores.map(([x, y], i) => (
        <g key={i} transform={`translate(${x - 22} ${y - 20})`}>
          <rect width="44" height="38" rx="8" fill={P} />
          <path d="M0 12h44" stroke={i === 2 ? A : F} strokeWidth="12" />
          <rect x="16" y="22" width="12" height="16" rx="2" fill={i === 2 ? S : F} opacity={i === 2 ? 1 : 0.35} />
        </g>
      ))}
    </svg>
  );
}

function Supplier() {
  return (
    <svg viewBox="0 0 240 160" aria-hidden="true">
      <rect width="240" height="160" fill="#e9e0cf" />
      <rect x="30" y="18" width="92" height="124" rx="8" fill={P} />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x="42" y={34 + i * 18} width={i % 2 ? 52 : 68} height="7" rx="3.5" fill={L} />
      ))}
      <rect x="24" y="72" width="104" height="3" rx="1.5" fill={A} />
      <rect x="24" y="66" width="104" height="14" fill={S} opacity=".25" />
      <path d="M134 80h30m-8-8 8 8-8 8" fill="none" stroke={F} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      {[
        [176, 92],
        [204, 92],
        [190, 64],
      ].map(([x, y], i) => (
        <g key={i} transform={`translate(${x - 13} ${y - 13})`}>
          <rect width="26" height="26" rx="4" fill={i === 2 ? S : F} opacity={i === 2 ? 1 : 0.85} />
          <path d="M0 9h26M13 0v9" stroke={P} strokeWidth="2" opacity=".6" />
        </g>
      ))}
    </svg>
  );
}

function Batches() {
  const rows = [
    ['#b23a2a', 0.55],
    [S, 0.72],
    [F, 0.86],
    [F, 0.64],
  ];
  return (
    <svg viewBox="0 0 240 160" aria-hidden="true">
      <rect width="240" height="160" fill="#e3ebe4" />
      <rect x="28" y="16" width="184" height="128" rx="12" fill={P} />
      {rows.map(([c, w], i) => (
        <g key={i} transform={`translate(42 ${30 + i * 27})`}>
          <rect width={92 * w} height="7" rx="3.5" fill={L} />
          <rect y="11" width="40" height="5" rx="2.5" fill={L} opacity=".7" />
          <rect x="112" y="1" width="46" height="14" rx="7" fill={c} opacity={c === F ? 0.18 : 0.9} />
          <rect x="120" y="6" width="30" height="4" rx="2" fill={c === F ? F : P} opacity={c === F ? 0.7 : 0.9} />
        </g>
      ))}
    </svg>
  );
}

function Books() {
  const bars = [40, 58, 46, 72, 64, 88];
  return (
    <svg viewBox="0 0 240 160" aria-hidden="true">
      <rect width="240" height="160" fill="#ece5d6" />
      <rect x="22" y="16" width="196" height="128" rx="12" fill={P} />
      {bars.map((h, i) => (
        <rect key={i} x={42 + i * 26} y={126 - h} width="16" height={h} rx="4" fill={i === bars.length - 1 ? F : F} opacity={i === bars.length - 1 ? 1 : 0.22 + i * 0.08} />
      ))}
      <path d="M50 90 L76 76 L102 84 L128 60 L154 66 L180 42" fill="none" stroke={A} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="180" cy="42" r="4.5" fill={A} />
      <rect x="36" y="26" width="38" height="14" rx="7" fill={S} />
      <rect x="44" y="31" width="22" height="4" rx="2" fill={F} opacity=".7" />
    </svg>
  );
}

const ARTS = { bill: Bill, branches: Branches, supplier: Supplier, batches: Batches, books: Books };

export default function AudienceArt({ art }) {
  const Art = ARTS[art] || Bill;
  return <Art />;
}
