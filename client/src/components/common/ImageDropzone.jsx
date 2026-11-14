import { useRef, useState } from 'react';
import { ImageOff, Loader2, Upload, X } from 'lucide-react';
import { cx } from './ui';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT = /\.(jpe?g|png|webp)$/i;

/** Why a chosen file cannot be sent, or '' when it can. The server checks the real bytes again; this only saves a round trip. */
export function imageProblem(file, maxMB) {
  if (!file) return 'Choose an image';
  if (!TYPES.includes(file.type) && !EXT.test(file.name || '')) return 'Use a JPG, PNG or WEBP image';
  if (file.type && !TYPES.includes(file.type)) return 'Use a JPG, PNG or WEBP image';
  if (!file.size) return 'That file is empty';
  if (file.size > maxMB * 1048576) return `Use a file up to ${maxMB} MB`;
  return '';
}

/**
 * A picture for a record: drag one in, or click to browse. The file is uploaded as soon as it is chosen and what is kept
 * is the address the server gives back, so the form holds a short string and not the bytes. An address that is already
 * stored (including an old plain link) is shown as the preview, and can be removed.
 */
export default function ImageDropzone({ value, onChange, upload, label = 'Product image', maxMB = 5, hint, error, disabled }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [broken, setBroken] = useState(false);
  const shown = problem || error;

  const take = async (file) => {
    const bad = imageProblem(file, maxMB);
    setProblem(bad);
    if (bad) return;
    setBusy(true);
    try {
      const url = await upload(file);
      setBroken(false);
      onChange(url);
    } catch (e) {
      setProblem(e.message || 'The image could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    if (disabled || busy) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) take(file);
  };
  const browse = () => !disabled && !busy && inputRef.current?.click();

  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-semibold">{label}</span>
      {value && !broken ? (
        <div className="flex items-center gap-3 rounded-xl border border-line bg-subtle/60 p-3">
          <img src={value} alt={label} className="h-16 w-16 shrink-0 rounded-lg border border-line bg-card object-cover" onError={() => setBroken(true)} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Image added</p>
            <p className="truncate text-xs text-muted">{value.split('/').pop()}</p>
          </div>
          <button type="button" onClick={browse} className="rounded-lg px-2 py-1 text-xs font-semibold text-accent hover:underline" disabled={disabled || busy}>
            Replace
          </button>
          <button type="button" aria-label="Remove image" onClick={() => { setBroken(false); onChange(''); }} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger" disabled={disabled || busy}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={browse}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          disabled={disabled}
          aria-describedby={shown ? 'image-problem' : undefined}
          className={cx(
            'flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors',
            over ? 'border-accent bg-accent/5' : shown ? 'border-danger/60 bg-danger-soft/30' : 'border-line bg-subtle/40 hover:border-accent/60 hover:bg-accent/5',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {busy ? <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden="true" /> : broken ? <ImageOff className="h-6 w-6 text-muted" aria-hidden="true" /> : <Upload className="h-6 w-6 text-muted" aria-hidden="true" />}
          <span className="text-sm font-bold text-accent">{busy ? 'Uploading…' : broken ? 'That image could not be shown — add another' : 'Click to browse file'}</span>
          <span className="text-xs text-muted">PNG, JPG or WEBP up to {maxMB} MB — or drop one here</span>
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" aria-label={label} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) take(f); }} />
      {shown ? (
        <p id="image-problem" role="alert" className="mt-1 text-xs text-danger">
          {shown}
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}
