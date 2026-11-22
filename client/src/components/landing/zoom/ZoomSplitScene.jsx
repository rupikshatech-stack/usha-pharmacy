import { useCallback, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import { Boxes, CalendarClock, ReceiptIndianRupee, RefreshCw } from 'lucide-react';
import ZoomCanvas from './ZoomCanvas';
import ScanHud from './ScanHud';
import StripLayers from './StripLayers';
import WarpStage from '../strip-carousel/WarpStage';
import { cx } from '../../common/ui';
import './zoomsplit.css';

gsap.registerPlugin(ScrollTrigger, useGSAP);

/*
 * The pinned "zoom and split" scene.
 *
 * One scrubbed timeline drives, in order: the canvas push-in, the HUD drawing itself, the copy swap, the wash to
 * the page background, and the layer split. The canvas reads its progress through a ref each frame rather than
 * from React state, so scrolling never re-renders this component.
 */

const CARDS = [
  { id: 'batch', layer: 'foil', icon: Boxes, title: 'Batch tracking', body: 'Every strip carries its batch from the moment it is received.' },
  { id: 'expiry', layer: 'label', icon: CalendarClock, title: 'Expiry monitoring', body: 'Dates are watched for you, so near-expiry stock sells first.' },
  { id: 'gst', layer: 'tablet', icon: ReceiptIndianRupee, title: 'GST calculation', body: 'Tax is worked out on the bill and carried into the return.' },
  { id: 'sync', layer: 'blister', icon: RefreshCw, title: 'Stock sync', body: 'The moment it is billed, stock drops across every branch.' },
];

const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function ZoomSplitScene() {
  const scene = useRef(null);
  const zoom = useRef(0);
  const [still] = useState(prefersStill);
  const [active, setActive] = useState(null);
  // Cards and layers have separate ids; the dot lights on the layer the hovered card points at.
  const activeLayer = CARDS.find((c) => c.id === active)?.layer ?? null;

  // Read by the canvas each frame; never a prop, so the scrub does not re-render React.
  const getProgress = useCallback(() => (still ? 1 : zoom.current), [still]);

  // Mouse hover only — a touch tap would otherwise leave a card stuck active.
  const onPointerEnter = (e, id) => {
    if (e.pointerType === 'mouse') setActive(id);
  };
  const onPointerLeave = (e) => {
    if (e.pointerType === 'mouse') setActive(null);
  };

  useGSAP(
    () => {
      const root = scene.current;
      const q = gsap.utils.selector(root);

      if (still) {
        // Calm static equivalent: already zoomed in, already split, no draw-on, no blur. The trigger survives
        // so the copy still swaps and the wash still lands, but nothing animates on its own.
        gsap.set(q('.zs-stack'), { '--spread': 1 });
        gsap.set(q('.zs-hud'), { opacity: 0.85, '--draw': 0 });
        gsap.set(q('.zs-canvas'), { opacity: 1, filter: 'none' });
        gsap.set(q('.zs-reveal'), { opacity: 1, y: 0 });
        gsap.set(q('.zs-wash'), { opacity: 1 }); // opaque: the wash is its own photograph now
        // the sequence ends on the warp cards, so reduced motion shows their still frame
        gsap.set(q('.zs-layers'), { opacity: 0 });
        gsap.set(q('.zs-warp'), { opacity: 1 });
        gsap.timeline({
          scrollTrigger: { trigger: root, start: 'top top', end: 'bottom bottom', scrub: true },
        }).to(q('.zs-copy'), { yPercent: -50, ease: 'none' });
        return;
      }

      gsap.set(q('.zs-stack'), { '--spread': 0 });
      gsap.set(q('.zs-hud'), { opacity: 0, '--draw': 1 });
      gsap.set(q('.zs-wash'), { opacity: 0 });
      gsap.set(q('.zs-reveal'), { opacity: 0, y: 28 });
      gsap.set(q('.zs-warp'), { opacity: 0 });
      gsap.set(q('.zs-layers'), { opacity: 1 });

      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: root,
          start: 'top top',
          end: 'bottom bottom',
          scrub: 1,
          invalidateOnRefresh: true,
        },
      });

      // 1. the push-in (the canvas polls zoom.current)
      tl.to(zoom, { current: 1, duration: 3 }, 0)
        // 2. the HUD draws itself over the code
        .to(q('.zs-hud'), { opacity: 1, duration: 0.4 }, 1.9)
        .to(q('.zs-hud'), { '--draw': 0, duration: 1.1, ease: 'power1.inOut' }, 2.1)
        // 3. hero copy out, feature copy in
        .to(q('.zs-copy'), { yPercent: -50, duration: 1.4, ease: 'power2.inOut' }, 3.1)
        // 4. wash to the page background, taking the photo and HUD with it
        .to(q('.zs-wash'), { opacity: 1, duration: 0.9 }, 3.6)
        .to(q('.zs-hud'), { opacity: 0, duration: 0.6 }, 3.7)
        // 5. the strip settles in, then splits into its layers
        .to(q('.zs-reveal'), { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' }, 4.2)
        .to(q('.zs-stack'), { '--spread': 1, duration: 1.6, ease: 'power2.inOut' }, 4.9)
        .to(q('.zs-cards'), { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' }, 5.4)
        // 6. once the layers are fully fanned out, hand the band over to the warp cards
        .to(q('.zs-layers'), { opacity: 0, duration: 0.7, ease: 'power1.inOut' }, 7.0)
        .to(q('.zs-warp'), { opacity: 1, duration: 0.7, ease: 'power1.inOut' }, 7.15);
    },
    { scope: scene },
  );

  return (
    <section ref={scene} className="zs-scene" aria-labelledby="zs-heading">
      <div className="zs-stage">
        {/* the photographed counter (a drawn stand-in) */}
        <ZoomCanvas getProgress={getProgress} className="zs-canvas" />
        <div className="zs-hud-wrap"><ScanHud /></div>
        <div className="zs-wash" aria-hidden="true" />

        {/* the strip, which the wash reveals and the scroll then splits */}
        <div className="zs-reveal">
          <div className="zs-stack"><StripLayers activeLayer={activeLayer} /></div>
          {/* revealed only once the split above has finished */}
          <WarpStage className="zs-warp" />
        </div>

        {/* two screens of copy on one track, swapped by yPercent */}
        <div className="zs-copy-mask">
          <div className="zs-copy">
            <div className="zs-copy__screen">
              <p className="zs-eyebrow">What a scan really carries</p>
              <h2 id="zs-heading" className="zs-title">Every strip has a story. Usha reads it.</h2>
              <p className="zs-lede">Scroll to follow one strip across the counter, down to the code that tells you its batch and its expiry.</p>
            </div>
            <div className="zs-copy__screen">
              <p className="zs-eyebrow">One scan, four records</p>
              <h2 className="zs-title">A strip is not one thing. Nor is the data.</h2>
              <p className="zs-lede">Foil, blister, tablet and printed label. Each carries something the system keeps track of for you.</p>
            </div>
          </div>
        </div>

        {/* the four features, each lighting its own layer */}
        <ul className="zs-cards">
          {CARDS.map(({ id, layer, icon: Icon, title, body }) => (
            <li key={id}>
              <button
                type="button"
                className={cx('zs-card', active === id && 'is-active')}
                data-for-layer={layer}
                onPointerEnter={(e) => onPointerEnter(e, id)}
                onPointerLeave={onPointerLeave}
                onFocus={() => setActive(id)}
                onBlur={() => setActive(null)}
              >
                <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
                <span className="zs-card__title">{title}</span>
                <span className="zs-card__body">{body}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="zs-note">Stock photograph. The batch and expiry shown are sample data.</p>
      </div>
    </section>
  );
}
