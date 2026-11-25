import { useRef, useState } from 'react';
import gsap from 'gsap';
import { BriefcaseMedical, Calculator, Pill, Store } from 'lucide-react';
import CanopyStage from './CanopyStage';
import AudienceArt from './overstory/AudienceArt';
import { Kicker, Plus, Split, onceInView, useOvReveals } from './overstory/parts';

/*
 * Who it's for, after the canopy: the sections of "Overstory Studio Landing" (MIT, Kedhareswer Naidu) that follow
 * its hero, rewritten for a pharmacy.
 *
 * Manifesto: a statement that fills in word by word as you read it, with small pictures popping in between.
 * Audience index: the template's service index. Rows draw their rules in, wipe in a tint and slide their titles on
 * hover, a preview card follows the cursor and swaps its drawing with a clip reveal, and a click opens the row.
 * Every claim is something the app does today.
 */

const MANIFESTO =
  'Usha Pharmacy is one system for the people who keep medicine moving. [team] From the batch you receive to the strip you sell, [chart] every rupee, every expiry date and every branch is in one place, [pill] so nothing on the shelf comes as a surprise.';

const AUDIENCES = [
  {
    title: 'Retail pharmacy',
    where: 'At the counter',
    art: 'bill',
    text: 'Bill from the keyboard with the right batch on every line, choose the payment mode, and take a sales return without leaving the screen.',
    tags: ['Selling Point', 'Batch selection', 'Payment modes', 'Sales returns'],
  },
  {
    title: 'Branch chains',
    where: 'Across stores',
    art: 'branches',
    text: 'Run every branch in one workspace: move stock between stores, compare how each branch performs, and give each person only the access their role needs.',
    tags: ['Stock transfers', 'Branch performance', 'Roles & permissions', 'Activity log'],
  },
  {
    title: 'Wholesale & distribution',
    where: 'Supplier to shelf',
    art: 'supplier',
    text: 'Raise purchase orders and approve them, receive goods against them batch by batch, and upload a supplier’s invoice to have it read for you before you review it.',
    tags: ['Purchase orders', 'Approvals', 'Goods receipts', 'Supplier invoices'],
  },
  {
    title: 'The stockroom',
    where: 'Batches & expiry',
    art: 'batches',
    text: 'Keep stock batch by batch with its expiry date, let reorder levels flag what to buy, and bring an existing inventory in from a CSV with a preview first.',
    tags: ['Batch-wise stock', 'Reorder levels', 'Expiry alerts', 'CSV import'],
  },
  {
    title: 'Owners & accountants',
    where: 'The books',
    art: 'books',
    text: 'GST reports, profitability and low stock, worked out from the same records as your sales and purchases, so the numbers always agree with the counter.',
    tags: ['GST reports', 'Profitability', 'Low stock', 'Sales & purchases'],
  },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function Manifesto() {
  const parts = MANIFESTO.split(/\s+/).filter(Boolean);
  return (
    <p className="lp-ov-man" data-manifesto>
      {parts.map((t, i) => {
        const pic = t.match(/^\[(team|chart|pill)\]$/)?.[1];
        if (pic === 'team') {
          // the people it is for: the counter, the pharmacist, the books
          return (
            <span key={i} className="lp-ov-pic lp-ov-pic-team" aria-hidden="true">
              {[Store, BriefcaseMedical, Calculator].map((Icon, k) => (
                <i key={k}>
                  <Icon strokeWidth={2.2} />
                </i>
              ))}
            </span>
          );
        }
        if (pic === 'chart') {
          return (
            <span key={i} className="lp-ov-pic lp-ov-pic-chart" aria-hidden="true">
              <svg viewBox="0 0 80 40">
                <path d="M4 34 L20 26 L32 30 L48 16 L60 20 L76 6" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="76" cy="6" r="4" fill="currentColor" />
              </svg>
            </span>
          );
        }
        if (pic === 'pill') {
          return (
            <span key={i} className="lp-ov-pic lp-ov-pic-pill" aria-hidden="true">
              <Pill strokeWidth={2.2} />
            </span>
          );
        }
        return (
          <span key={i}>
            <span data-mw>{t}</span>{' '}
          </span>
        );
      })}
    </p>
  );
}

export default function Audiences() {
  const body = useRef(null);
  const [open, setOpen] = useState(-1);
  const [hover, setHover] = useState(0);

  useOvReveals(body, (q) => {
    // the preview follows a mouse on screens wide enough for it; on narrow ones it would cover the titles
    const fine = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 820px)').matches;
    const stops = [];

    /* the manifesto reads itself in: a scrub from "top 78%" to "bottom 45%", read from the element's live position
       every frame (see parts.jsx for why not ScrollTrigger). Words fill in turn: each takes 0.5 of the timeline and
       starts 0.08 after the one before, exactly as the template's stagger. */
    const man = q('[data-manifesto]')[0];
    if (man) {
      const words = [...man.querySelectorAll('[data-mw]')];
      const total = 0.5 + (words.length - 1) * 0.08;
      let raf = 0;
      let last = -1;
      const paint = () => {
        raf = 0;
        const r = man.getBoundingClientRect();
        const vh = window.innerHeight;
        const p = Math.min(1, Math.max(0, (0.78 * vh - r.top) / (0.33 * vh + r.height)));
        if (p === last) return;
        last = p;
        const t = p * total;
        words.forEach((w, i) => {
          w.style.opacity = (0.12 + 0.88 * Math.min(1, Math.max(0, (t - i * 0.08) / 0.5))).toFixed(3);
        });
      };
      const kick = () => {
        if (!raf) raf = requestAnimationFrame(paint);
      };
      paint();
      window.addEventListener('scroll', kick, { passive: true });
      window.addEventListener('resize', kick);
      stops.push(() => {
        cancelAnimationFrame(raf);
        window.removeEventListener('scroll', kick);
        window.removeEventListener('resize', kick);
      });
      const pics = man.querySelectorAll('.lp-ov-pic');
      gsap.set(pics, { scale: 0, rotate: -12 });
      stops.push(onceInView(man, () => gsap.to(pics, { scale: 1, rotate: 0, ease: 'back.out(2)', duration: 0.9, stagger: 0.2 }), 0.6));
    }

    /* the index: rows draw their rules, the preview follows the cursor */
    const list = q('.lp-ov-svc-list')[0];
    const rows = q('.lp-ov-svc-row');
    gsap.set(rows, { '--lp-ov-rule': 0 });
    stops.push(onceInView(list, () => gsap.to(rows, { '--lp-ov-rule': 1, duration: 1.4, stagger: 0.08, ease: 'expo.inOut' }), 0.85));
    const prev = q('.lp-ov-svc-prev')[0];
    const done = () => stops.forEach((s) => s());
    if (fine && list && prev) {
      const px = gsap.quickTo(prev, 'x', { duration: 0.6, ease: 'power3.out' });
      const py = gsap.quickTo(prev, 'y', { duration: 0.6, ease: 'power3.out' });
      const pr = gsap.quickTo(prev, 'rotate', { duration: 0.8, ease: 'power3.out' });
      let lx = 0;
      const mv = (e) => {
        const b = list.getBoundingClientRect();
        const x = e.clientX - b.left;
        // keep the card on the list's side of the screen
        px(clamp(x + 28, 0, b.width - 250));
        py(e.clientY - b.top - 90);
        pr(clamp((x - lx) * 0.6, -10, 10));
        lx = x;
      };
      const en = () => gsap.to(prev, { autoAlpha: 1, scale: 1, duration: 0.5, ease: 'expo.out' });
      const lv = () => gsap.to(prev, { autoAlpha: 0, scale: 0.6, duration: 0.4, ease: 'power3.in' });
      gsap.set(prev, { autoAlpha: 0, scale: 0.6 });
      list.addEventListener('pointermove', mv);
      list.addEventListener('pointerenter', en);
      list.addEventListener('pointerleave', lv);
      return () => {
        list.removeEventListener('pointermove', mv);
        list.removeEventListener('pointerenter', en);
        list.removeEventListener('pointerleave', lv);
        done();
      };
    }
    return done;
  });

  return (
    <section id="who" aria-labelledby="who-heading" className="lp-who scroll-mt-20">
      {/* the view up through the trees with the heading in the patch of sky; scrolling rises through it into mist */}
      <CanopyStage eyebrow="Who it’s for" lines={['Made for how pharmacies', 'actually work']} headingId="who-heading" seed={23} />

      <div ref={body} className="lp-ov">
        <div className="lp-ov-sec lp-ov-sec--man">
          <div className="lp-ov-wrap">
            <Kicker n="01" text="Above the canopy" />
            <Manifesto />
          </div>
        </div>

        <div className="lp-ov-sec">
          <div className="lp-ov-wrap">
            <div className="lp-ov-head">
              <div>
                <Kicker n="02" text="Who it’s for" />
                <Split as="h3" text="One system, five ways to run a pharmacy" />
              </div>
              <p className="lp-ov-lede" data-rv>
                The counter, the branches, the suppliers, the stockroom and the books all work from the same records, so each team sees what it needs and nothing is typed twice.
              </p>
            </div>
            <div className="lp-ov-svc-list" onPointerLeave={() => setHover(open >= 0 ? open : 0)}>
              <div className="lp-ov-svc-prev" aria-hidden="true">
                {AUDIENCES.map((a, i) => (
                  <div key={a.title} className="lp-ov-svc-art" data-on={i === hover ? '' : undefined}>
                    <AudienceArt art={a.art} />
                  </div>
                ))}
              </div>
              {AUDIENCES.map((a, i) => {
                const isOpen = open === i;
                return (
                  <div key={a.title} className="lp-ov-svc-row" data-open={isOpen ? '' : undefined} onPointerEnter={() => setHover(i)}>
                    <h4 className="lp-ov-svc-h">
                      <button type="button" aria-expanded={isOpen} aria-controls={`aud-row-${i}`} onClick={() => setOpen(isOpen ? -1 : i)} onFocus={() => setHover(i)}>
                        <span className="lp-ov-svc-n">0{i + 1}</span>
                        <span className="lp-ov-svc-t">{a.title}</span>
                        <span className="lp-ov-svc-time">{a.where}</span>
                        <Plus />
                      </button>
                    </h4>
                    <div id={`aud-row-${i}`} className="lp-ov-fold" role="region" aria-label={a.title}>
                      <div>
                        <div className="lp-ov-svc-body">
                          <p>{a.text}</p>
                          <ul>
                            {a.tags.map((t) => (
                              <li key={t}>{t}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
