import { Fragment } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

/*
 * Shared pieces of the sections ported from "Overstory Studio Landing" (MIT, Kedhareswer Naidu): the word-split
 * heading, the ( 01 ) kicker, and the reveals they share. Everything visual is prefixed .lp-ov- in landing.css.
 *
 * The template starts these reveals with ScrollTrigger. Here they start from the elements' own visibility instead
 * (IntersectionObserver, at the same lines on the screen): on wide screens the pinned scenes higher up the page left
 * ScrollTrigger's stored positions for everything below them thousands of pixels early, so every reveal had already
 * played before you got there. Visibility cannot go stale.
 */

export const stillMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Calls `fn(targets)` once per element when its top passes `line` (a fraction of the screen height from the top,
 * like ScrollTrigger's "top 88%"). Returns a function that stops watching.
 */
export function onceInView(els, fn, line = 0.88) {
  const list = (Array.isArray(els) ? els : [els]).filter(Boolean);
  if (!list.length) return () => {};
  const io = new IntersectionObserver(
    (es) => {
      const hit = es.filter((e) => e.isIntersecting).map((e) => e.target);
      if (!hit.length) return;
      hit.forEach((t) => io.unobserve(t));
      fn(hit);
    },
    { rootMargin: `0px 0px -${Math.round((1 - line) * 100)}% 0px` },
  );
  list.forEach((el) => io.observe(el));
  return () => io.disconnect();
}

/** A heading whose words rise one by one out of their own masks when it scrolls in. */
export function Split({ text, as: Tag = 'h2', id, className = '' }) {
  const words = text.split(' ');
  return (
    <Tag id={id} className={`lp-ov-h2 ${className}`} data-split>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="lp-ov-w">
            <span data-w>{w}</span>
          </span>
          {i < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </Tag>
  );
}

export function Kicker({ n, text, light = false }) {
  return (
    <p className={light ? 'lp-ov-kicker lp-ov-kicker--light' : 'lp-ov-kicker'} data-rv>
      <span className="lp-ov-kicker-n">( {n} )</span>
      <span>{text}</span>
    </p>
  );
}

/** The plus that turns into a cross when its row or question is open. */
export function Plus() {
  return <span className="lp-ov-plus" aria-hidden="true" />;
}

/**
 * The template's shared reveals inside `scope`: split headings rise word by word, and every [data-rv] block eases up
 * as it arrives. Extra section-specific motion goes in `more(q)`, run with the same scope; a function it returns is
 * run when the section unmounts.
 */
export function useOvReveals(scope, more) {
  useGSAP(
    () => {
      if (stillMotion()) return undefined;
      const q = gsap.utils.selector(scope);
      const stops = [];
      q('[data-split]').forEach((h) => {
        const ws = h.querySelectorAll('[data-w]');
        gsap.set(ws, { yPercent: 115, rotate: 3 });
        stops.push(onceInView(h, () => gsap.to(ws, { yPercent: 0, rotate: 0, duration: 1.3, stagger: 0.045, ease: 'expo.out' })));
      });
      const rv = q('[data-rv]');
      if (rv.length) {
        gsap.set(rv, { autoAlpha: 0, y: 34 });
        stops.push(onceInView(rv, (batch) => gsap.to(batch, { autoAlpha: 1, y: 0, duration: 1.1, stagger: 0.08, ease: 'expo.out', overwrite: true }), 0.9));
      }
      const extra = more?.(q);
      return () => {
        stops.forEach((s) => s());
        extra?.();
      };
    },
    { scope },
  );
}
