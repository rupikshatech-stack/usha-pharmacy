import { cx } from '../../common/ui';

/*
 * The strip's four physical layers. All four are centred on one point and shifted sideways by
 * `--i * --lens-step * --spread`, so at --spread:0 they stack into a single object and at 1 they fan out evenly.
 *
 * THESE ARE STAND-INS. No artwork was supplied, so each layer is a CSS shape with the right proportions, marked
 * `.stand-in`. To drop in real art later, put a transparent PNG (same height, centred in its file) inside the
 * matching `[data-layer]` element and delete the `.stand-in` child — no other change is needed.
 */

export const LAYERS = [
  { id: 'foil', name: 'Foil backing', carries: 'Batch and lot, printed', i: -1.5 },
  { id: 'blister', name: 'Blister plastic', carries: 'Pack size, units left', i: -0.5 },
  { id: 'tablet', name: 'Tablet', carries: 'The unit you bill', i: 0.5 },
  { id: 'label', name: 'Printed label', carries: 'Expiry date, scanned', i: 1.5 },
];

export default function StripLayers({ activeLayer }) {
  return (
    <div className={cx('zs-layers', activeLayer && 'has-active')} aria-hidden="true">
      {LAYERS.map(({ id, name, carries, i }, n) => (
        <div
          key={id}
          data-layer={id}
          className={cx('zs-layer', activeLayer === id && 'is-lit')}
          style={{ '--i': i }}
        >
          <div className={cx('stand-in', `stand-in--${id}`)}>
            {id === 'foil' && Array.from({ length: 6 }, (_, k) => <span key={k} className="stand-in__emboss" />)}
            {id === 'blister' && Array.from({ length: 6 }, (_, k) => <span key={k} className="stand-in__dome" />)}
            {id === 'tablet' && Array.from({ length: 6 }, (_, k) => <span key={k} className="stand-in__pill" />)}
            {id === 'label' && (
              <>
                <span className="stand-in__brand">Usha Pharmacy</span>
                <span className="stand-in__code" />
                <span className="stand-in__row"><b>BATCH</b> PC4410</span>
                <span className="stand-in__row"><b>EXP</b> 03 / 2027</span>
              </>
            )}
          </div>
          <span className="zs-dot" />
          <span className="zs-layer__meta">
            <span className="zs-layer__num">{String(n + 1).padStart(2, '0')}</span>
            <span className="zs-layer__name">{name}</span>
            <span className="zs-layer__carries">{carries}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
