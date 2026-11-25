import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Plus } from 'lucide-react';
import { inr } from '../../utils/format';
import { cx } from '../common/ui';

/*
 * One self-playing phone per step of "How it works": a simulated cursor taps through the step while the screen
 * reacts, then it resets and plays again. Illustrative data only, never the API, and no library: timers and state.
 *
 * Each phone is its own async script, so the three run side by side and never wait on each other. They run from
 * the moment the page is ready, wherever the visitor has scrolled, so whichever card the horizontal track brings
 * into view is already mid-flow. With reduced motion nothing starts: every phone rests on the settled state of
 * its flow.
 *
 * The cursor is placed from each target's layout offsets within the phone's screen, measured at the moment it moves,
 * so it stays on target however large the card is drawn and however the filmstrip tilts it.
 */

const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const STOP = Symbol('demo stopped');

/**
 * Runs `script` forever from mount until unmount. The first run waits for fonts, then a beat, so the layout the
 * cursor measures is the layout that stays. A pass that throws is logged and the next pass starts after a pause,
 * so one failure can never leave a phone frozen mid-flow. Unmounting cancels it: every pending sleep resolves and
 * the next checkpoint throws STOP, so nothing is left running.
 */
function useDemoLoop(script) {
  const live = useRef(script);
  live.current = script;

  useEffect(() => {
    if (prefersStill()) return undefined;
    let dead = false;
    const pending = new Set();
    const wait = async (ms) => {
      await new Promise((resolve) => {
        const entry = { resolve, t: 0 };
        entry.t = window.setTimeout(() => {
          pending.delete(entry);
          resolve();
        }, ms);
        pending.add(entry);
      });
      if (dead) throw STOP;
    };
    (async () => {
      try {
        // wait for fonts so the cursor measures the final layout, but never longer than 1.5s: a fonts promise that
        // never settles must not leave the phone parked on its first frame
        await Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 1500))]);
        await wait(700);
        for (;;) {
          try {
            await live.current({ wait });
          } catch (e) {
            if (e === STOP) throw e;
            // a single bad pass must never freeze the phone: say so, pause, and start again from the top
            // (every script opens by resetting its own state)
            console.error('How it works demo: a pass failed, restarting it', e);
            await wait(1000);
          }
        }
      } catch (e) {
        if (e !== STOP) console.error(e);
      }
    })();
    return () => {
      dead = true;
      pending.forEach((entry) => {
        clearTimeout(entry.t);
        entry.resolve();
      });
    };
  }, []);
}

/** The round cursor dot and the moves it makes. Every move resolves once the dot has arrived. */
function useCursor(screenRef) {
  const [cursor, setCursor] = useState({ x: 0, y: 0, on: false, press: false });

  const spot = useCallback(
    (el, fx = 0.5, fy = 0.5) => {
      const screen = screenRef.current;
      // Walk the layout offsets up to the screen. Unlike bounding boxes these ignore transforms, so the point is
      // exact in the screen's own pixels even while the card is scaled to its slot and tilted by the filmstrip.
      let x = 0;
      let y = 0;
      let n = el;
      while (n && n !== screen) {
        x += n.offsetLeft;
        y += n.offsetTop;
        n = n.offsetParent;
      }
      if (n === screen) return { x: x + el.offsetWidth * fx, y: y + el.offsetHeight * fy };
      // not laid out under the screen (should not happen): fall back to the boxes, undoing the scale
      const s = screen.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const k = s.width / (screen.offsetWidth || s.width) || 1;
      return { x: (r.left - s.left + r.width * fx) / k, y: (r.top - s.top + r.height * fy) / k };
    },
    [screenRef],
  );

  const moveTo = useCallback(
    async (wait, el, fx, fy) => {
      setCursor((c) => ({ ...c, ...spot(el, fx, fy), on: true }));
      await wait(560); // the CSS transition is 0.5s
    },
    [spot],
  );

  /** Fades in from the lower right of the screen, then travels to the first target. */
  const enter = useCallback(
    async (wait, el) => {
      const screen = screenRef.current;
      setCursor({ x: screen.offsetWidth * 0.82, y: screen.offsetHeight * 0.9, on: false, press: false });
      await frame();
      setCursor((c) => ({ ...c, on: true }));
      await wait(320);
      await moveTo(wait, el);
    },
    [moveTo, screenRef],
  );

  const tap = useCallback(async (wait) => {
    setCursor((c) => ({ ...c, press: true }));
    await wait(160);
    setCursor((c) => ({ ...c, press: false }));
    await wait(140);
  }, []);

  const hide = useCallback(() => setCursor((c) => ({ ...c, on: false, press: false })), []);

  return { cursor, enter, moveTo, tap, hide };
}

/** Types `text` one character at a time through `set`, at a human, slightly uneven pace. */
async function typeInto(wait, text, set, ms = 55) {
  for (let i = 1; i <= text.length; i += 1) {
    set(text.slice(0, i));
    await wait(ms * (0.75 + Math.random() * 0.5));
  }
}

/**
 * The step's screenshot, if the file is there. It stays invisible until it has loaded and is dropped if it fails,
 * so a missing file leaves the tinted screen rather than a broken image or an alt-text box.
 */
function Shot({ src }) {
  const [state, setState] = useState('loading');
  if (!src || state === 'missing') return null;
  return (
    <img
      src={src}
      alt=""
      draggable="false"
      onLoad={() => setState('ready')}
      onError={() => setState('missing')}
      className={cx('absolute inset-0 h-full w-full object-cover transition-opacity duration-300', state === 'ready' ? 'opacity-100' : 'opacity-0')}
    />
  );
}

/**
 * The phone itself: bezel, screen, the cursor and the toast. The screen is the section's tint, then the step's
 * screenshot if there is one, then the live UI drawn over it slightly translucent, so the demo reads as interaction
 * on that screen. Decorative, so hidden from assistive technology.
 */
function Phone({ hostRef, screenRef, cursor, toast, screenshot, children }) {
  return (
    <div ref={hostRef} aria-hidden="true" className="mx-auto w-[15.5rem] select-none">
      <div className="rounded-[2.4rem] bg-ink p-2.5 shadow-[0_28px_50px_-24px_rgba(10,22,18,0.6)]">
        <div ref={screenRef} className="lp-ph-screen relative flex h-[31rem] flex-col overflow-hidden rounded-[1.95rem] text-left">
          <Shot src={screenshot} />
          <div className="relative z-[1] flex flex-1 flex-col bg-card/90">{children}</div>
          {/* the status bar: a band of the brand green with the notch in it */}
          <span className="absolute inset-x-0 top-0 z-[2] h-10 bg-side" />
          <span className="absolute left-1/2 top-2 z-[2] h-4 w-16 -translate-x-1/2 rounded-full bg-ink" />
          <span className={cx('lp-ph-toast', toast.on && 'is-on')}>
            <Check size={11} strokeWidth={3} className="text-sage" />
            {toast.text}
          </span>
          <span
            className="lp-ph-cursor"
            data-on={cursor.on}
            data-press={cursor.press}
            style={{ left: cursor.x, top: cursor.y }}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ Sign in */

const EMAIL = 'owner@usha.app';
const PASS_LEN = 10;
const SIGN_IN_START = { email: '', pass: 0, focus: '', btn: 'idle', toast: false };

function SignInPhone({ screenshot }) {
  const host = useRef(null);
  const screen = useRef(null);
  const emailEl = useRef(null);
  const passEl = useRef(null);
  const btnEl = useRef(null);
  const [s, setS] = useState(() => (prefersStill() ? { ...SIGN_IN_START, email: EMAIL, pass: PASS_LEN } : SIGN_IN_START));
  const patch = (p) => setS((o) => ({ ...o, ...p }));
  const { cursor, enter, moveTo, tap, hide } = useCursor(screen);

  useDemoLoop(
    async ({ wait }) => {
      patch(SIGN_IN_START);
      await wait(600);
      await enter(wait, emailEl.current);
      patch({ focus: 'email' });
      await tap(wait);
      await wait(250);
      await typeInto(wait, EMAIL, (email) => patch({ email }));
      await wait(550);

      await moveTo(wait, passEl.current);
      patch({ focus: 'pass' });
      await tap(wait);
      await wait(250);
      for (let n = 1; n <= PASS_LEN; n += 1) {
        patch({ pass: n });
        await wait(60 + Math.random() * 35);
      }
      await wait(550);

      await moveTo(wait, btnEl.current);
      patch({ focus: '', btn: 'press' });
      await tap(wait);
      patch({ btn: 'busy' });
      await wait(800);
      patch({ btn: 'idle', toast: true });
      await wait(1300);
      patch({ toast: false });
      await wait(500);
      hide();
      await wait(1000);
    },
  );

  return (
    <Phone hostRef={host} screenRef={screen} cursor={cursor} screenshot={screenshot} toast={{ text: 'Welcome back', on: s.toast }}>
      <div className="flex flex-1 flex-col px-4 pb-5 pt-[4.75rem]">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-muted">Usha Pharmacy</p>
        <p className="mt-1 text-[15px] font-extrabold leading-tight tracking-tight text-ink">Sign in to your workspace</p>

        <p className="mt-6 text-[10px] font-semibold text-muted">Email</p>
        <div ref={emailEl} className={cx('lp-ph-field mt-1', s.focus === 'email' && 'is-focus')}>
          {s.email ? <span className="truncate">{s.email}</span> : <span className="text-muted/70">you@pharmacy.com</span>}
          {s.focus === 'email' && <i className="lp-ph-caret" />}
        </div>

        <p className="mt-3.5 text-[10px] font-semibold text-muted">Password</p>
        <div ref={passEl} className={cx('lp-ph-field mt-1', s.focus === 'pass' && 'is-focus')}>
          {s.pass ? <span className="tracking-[0.16em]">{'•'.repeat(s.pass)}</span> : <span className="text-muted/70">Your password</span>}
          {s.focus === 'pass' && <i className="lp-ph-caret" />}
        </div>

        <div
          ref={btnEl}
          className={cx(
            'lp-ph-btn mt-auto h-10 bg-primary text-[12.5px] font-bold text-on-primary',
            s.btn === 'press' && 'is-press',
          )}
        >
          {s.btn === 'busy' ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Signing in…
            </>
          ) : (
            'Sign in'
          )}
        </div>
      </div>
    </Phone>
  );
}

/* ------------------------------------------------------------------------------------------------ Stock */

const STOCK_ROWS = [
  { name: 'Paracetamol 500mg', meta: 'PC4410 · exp 08/27', qty: 240 },
  { name: 'Cetirizine 10mg', meta: 'CT8820 · exp 11/27', qty: 180 },
];
const NEW_STOCK = { name: 'Azithromycin 250mg', meta: 'AZ1187 · exp 03/28', qty: 96 };
const STOCK_START = { added: false, leaving: false, toast: false, press: false };

function StockRow({ row, className }) {
  return (
    <div className={cx('flex items-center justify-between rounded-xl border border-ink/10 px-3 py-2', className)}>
      <div className="min-w-0">
        <p className="truncate text-[12px] font-semibold text-ink">{row.name}</p>
        <p className="mt-0.5 truncate text-[10px] text-muted">{row.meta}</p>
      </div>
      <p className="ml-2 shrink-0 text-[12px] font-bold tabular-nums text-ink">{row.qty}</p>
    </div>
  );
}

function StockPhone({ screenshot }) {
  const host = useRef(null);
  const screen = useRef(null);
  const addEl = useRef(null);
  const [s, setS] = useState(() => (prefersStill() ? { ...STOCK_START, added: true } : STOCK_START));
  const patch = (p) => setS((o) => ({ ...o, ...p }));
  const { cursor, enter, tap, hide } = useCursor(screen);

  useDemoLoop(
    async ({ wait }) => {
      patch(STOCK_START);
      await wait(700);
      await enter(wait, addEl.current);
      patch({ press: true });
      await tap(wait);
      patch({ press: false, added: true });
      await wait(900);
      patch({ toast: true });
      await wait(1300);
      patch({ toast: false });
      await wait(1100);
      hide();
      patch({ leaving: true });
      await wait(450);
      patch({ added: false, leaving: false });
      await wait(1100);
    },
  );

  const units = STOCK_ROWS.reduce((n, r) => n + r.qty, 0) + (s.added && !s.leaving ? NEW_STOCK.qty : 0);

  return (
    <Phone hostRef={host} screenRef={screen} cursor={cursor} screenshot={screenshot} toast={{ text: 'Stock added', on: s.toast }}>
      <div className="flex flex-1 flex-col px-4 pb-4 pt-[4.75rem]">
        <div className="flex items-center justify-between">
          <p className="text-[15px] font-extrabold tracking-tight text-ink">Stock</p>
          <div ref={addEl} className={cx('lp-ph-btn h-8 gap-1 bg-primary px-3 text-[11px] font-bold text-on-primary', s.press && 'is-press')}>
            <Plus size={12} strokeWidth={3} /> Add stock
          </div>
        </div>

        <div className="mt-3 rounded-xl bg-sage px-3 py-2">
          <p className="text-[10px] font-semibold text-sage-ink">Units on hand</p>
          <p className="text-[17px] font-extrabold tabular-nums leading-tight text-ink">{units}</p>
        </div>

        <div className="mt-3 space-y-2">
          {STOCK_ROWS.map((r) => (
            <StockRow key={r.name} row={r} />
          ))}
          {s.added && <StockRow key="new" row={NEW_STOCK} className={s.leaving ? 'lp-ph-row-out' : 'lp-ph-row-in'} />}
        </div>
      </div>
    </Phone>
  );
}

/* ------------------------------------------------------------------------------------------------ Billing */

const BILL_ITEMS = [
  { name: 'Paracetamol 500mg', qty: 2, rate: 18.5 },
  { name: 'Cetirizine 10mg', qty: 1, rate: 32 },
];
const lineOf = (i) => i.qty * i.rate;
const billTotal = (n) => BILL_ITEMS.slice(0, n).reduce((sum, i) => sum + lineOf(i), 0);
const BILL_START = { items: 0, total: 0, press: '', done: false, toast: false };

function BillingPhone({ screenshot }) {
  const host = useRef(null);
  const screen = useRef(null);
  const addEl = useRef(null);
  const doneEl = useRef(null);
  const [s, setS] = useState(() =>
    prefersStill() ? { ...BILL_START, items: BILL_ITEMS.length, total: billTotal(BILL_ITEMS.length) } : BILL_START,
  );
  const patch = (p) => setS((o) => ({ ...o, ...p }));
  const { cursor, enter, moveTo, tap, hide } = useCursor(screen);

  /** Ticks the displayed total up to `to` in a few quick steps, so a new line visibly moves the number. */
  const tick = async (wait, from, to) => {
    for (let k = 1; k <= 8; k += 1) {
      patch({ total: from + ((to - from) * k) / 8 });
      await wait(40);
    }
  };

  useDemoLoop(
    async ({ wait }) => {
      patch(BILL_START);
      await wait(700);
      await enter(wait, addEl.current);

      for (let n = 1; n <= BILL_ITEMS.length; n += 1) {
        patch({ press: 'add' });
        await tap(wait);
        patch({ press: '', items: n });
        await tick(wait, billTotal(n - 1), billTotal(n));
        await wait(n === 1 ? 900 : 700);
      }

      await moveTo(wait, doneEl.current);
      patch({ press: 'done' });
      await tap(wait);
      patch({ press: '', done: true }); // the success flash
      await wait(350);
      patch({ toast: true });
      await wait(850);
      patch({ done: false }); // back to its own label after about 1.2s
      await wait(450);
      patch({ toast: false }); // the toast has held about 1.3s
      await wait(700);
      hide();
      await wait(400);
      patch(BILL_START);
      await wait(1000);
    },
  );

  return (
    <Phone hostRef={host} screenRef={screen} cursor={cursor} screenshot={screenshot} toast={{ text: 'Sale complete', on: s.toast }}>
      <div className="flex flex-1 flex-col px-4 pb-4 pt-[4.75rem]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[15px] font-extrabold leading-tight tracking-tight text-ink">New bill</p>
            <p className="text-[10px] text-muted">INV-1286</p>
          </div>
          <div
            ref={addEl}
            className={cx('lp-ph-btn h-8 gap-1 border border-ink/15 px-2.5 text-[11px] font-bold text-ink', s.press === 'add' && 'is-press')}
          >
            <Plus size={12} strokeWidth={3} /> Add item
          </div>
        </div>

        <div className="mt-3 min-h-[6.6rem] space-y-2">
          {BILL_ITEMS.slice(0, s.items).map((i) => (
            <div key={i.name} className="lp-ph-row-in flex items-center justify-between rounded-xl border border-ink/10 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[12px] font-semibold text-ink">{i.name}</p>
                <p className="mt-0.5 text-[10px] tabular-nums text-muted">
                  {i.qty} × {inr(i.rate)}
                </p>
              </div>
              <p className="ml-2 shrink-0 text-[12px] font-bold tabular-nums text-ink">{inr(lineOf(i))}</p>
            </div>
          ))}
          {!s.items && <p className="px-1 pt-7 text-center text-[11px] text-muted">No items yet</p>}
        </div>

        <div className="mt-3 flex items-baseline justify-between rounded-xl bg-sage px-3 py-2">
          <span className="text-[11px] font-semibold text-sage-ink">Total</span>
          <span className="text-[19px] font-extrabold tabular-nums leading-tight text-ink">{inr(s.total)}</span>
        </div>

        <div
          ref={doneEl}
          className={cx(
            'lp-ph-btn mt-auto h-10 text-[12.5px] font-bold',
            s.done ? 'bg-success-soft text-success' : 'bg-primary text-on-primary',
            s.press === 'done' && 'is-press',
          )}
        >
          {s.done ? (
            <>
              <Check size={14} strokeWidth={3} /> Paid
            </>
          ) : (
            'Complete sale'
          )}
        </div>
      </div>
    </Phone>
  );
}

/** The phone for step `step` (0 sign in, 1 stock, 2 billing), over `screenshot` when that file exists. */
export default function StepPhone({ step, screenshot }) {
  if (step === 0) return <SignInPhone screenshot={screenshot} />;
  if (step === 1) return <StockPhone screenshot={screenshot} />;
  return <BillingPhone screenshot={screenshot} />;
}
