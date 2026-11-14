import { AlertTriangle, Check, Loader2, Undo2 } from 'lucide-react';
import { Button, cx } from '../common/ui';

/**
 * The bar that appears when there is unsaved work.
 *
 * It says HOW MANY fields are unsaved rather than just "unsaved changes", because on a long settings page the
 * useful question is "did I change one thing or six?". It stays stuck to the bottom of the screen so the answer is
 * never scrolled away from, and Save is disabled until there is actually something to save — a button that can be
 * pressed when nothing has changed teaches people that pressing it means nothing.
 */
export default function SaveBar({ count, saving, onSave, onDiscard, error, savedAt, inline }) {
  const dirty = count > 0;

  if (!dirty && !savedAt) return null;

  /**
   * `inline` is for a dialog, which supplies its own bordered footer strip.
   *
   * Without it the page version's styling comes along: negative margins that pull it wider than its container,
   * `sticky bottom-0` against a footer that is already pinned, and a second border and background inside the
   * dialog's own — which reads as a floating panel with a gap beneath it. The wording, the counting and the two
   * buttons are what this component is for, so those stay identical in both places; only the page chrome drops.
   */
  return (
    <div
      className={cx(
        inline
          ? 'w-full'
          : cx('sticky bottom-0 z-20 -mx-4 mt-4 border-t px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6', dirty ? 'border-warning/40 bg-warning/10' : 'border-line bg-card/90'),
      )}
      role="status"
      aria-live="polite"
    >
      <div className={cx('flex flex-wrap items-center justify-between gap-3', !inline && 'mx-auto max-w-[1400px]')}>
        <div className="flex min-w-0 items-center gap-2.5 text-sm">
          {dirty ? (
            <>
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <span className="font-semibold">
                {count} unsaved {count === 1 ? 'change' : 'changes'}
              </span>
              {error && <span className="truncate text-danger">· {error}</span>}
            </>
          ) : (
            <>
              <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span className="text-muted">
                Saved {savedAt ? new Date(savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}
              </span>
            </>
          )}
        </div>

        {dirty && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onDiscard} disabled={saving}>
              <Undo2 className="h-4 w-4" aria-hidden="true" /> Discard
            </Button>
            <Button onClick={onSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
              {saving ? 'Saving…' : `Save ${count} ${count === 1 ? 'change' : 'changes'}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
