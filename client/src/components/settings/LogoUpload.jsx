import { useRef, useState } from 'react';
import { ImageOff, Loader2, Replace, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { settingsService } from '../../services/settingsService';
import { Button, cx } from '../common/ui';
import { LOGO_MAX_MB as MAX_MB, logoProblem } from '../../utils/logoFile';

/**
 * Crops to a centred square and scales down, in the browser, before anything is uploaded.
 *
 * The logo is printed in a small square on invoices and shown in the sidebar, so a 4000-pixel-wide banner is both
 * the wrong shape and far more bytes than the job needs. Doing it here means the file that leaves the machine is
 * the file that will be used — there is no second, hidden version on the server that could drift from the preview.
 * If anything about the canvas fails, the original file is uploaded unchanged rather than nothing at all.
 */
async function cropToSquare(file, size = 512) {
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    // PNG and WebP keep transparency; a JPEG cannot, so it gets white rather than black behind it.
    if (file.type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
    }
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    bitmap.close?.();
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, type === 'image/png' ? '.png' : '.jpg'), { type });
  } catch {
    return file; // an unreadable image is the server's answer to give, not ours
  }
}

/**
 * The store logo: drag one in or click to browse. The file is uploaded as soon as it is chosen — a logo is one
 * field with its own endpoint, so it is not part of the unsaved-changes count on the rest of the form.
 */
export default function LogoUpload({ value, onChange, disabled }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const choose = async (file) => {
    const problem = logoProblem(file);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const squared = await cropToSquare(file);
      const saved = await settingsService.uploadLogo(squared);
      onChange(saved.url);
      toast.success('Logo saved. It is live on invoices and in the sidebar now.');
    } catch (e) {
      setError(e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await settingsService.deleteLogo();
      onChange('');
      toast.success('Logo removed and saved.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-field="logo">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) choose(e.dataTransfer.files?.[0]);
        }}
        className={cx(
          'relative grid min-h-[11rem] place-items-center rounded-2xl border-2 border-dashed p-4 text-center transition-colors',
          over ? 'border-primary bg-sage/40' : 'border-line bg-subtle/40',
          disabled && 'opacity-60',
        )}
      >
        {busy ? (
          <div className="flex flex-col items-center gap-2 text-muted">
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            <span className="text-xs">Uploading…</span>
          </div>
        ) : value ? (
          <div className="flex flex-col items-center gap-3">
            <img src={value} alt="Store logo" className="h-24 w-24 rounded-xl border border-line bg-card object-contain" />
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={disabled}>
                <Replace className="h-3.5 w-3.5" aria-hidden="true" /> Replace
              </Button>
              <Button variant="secondary" size="sm" onClick={remove} disabled={disabled}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Remove
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled} className="flex flex-col items-center gap-2 text-muted">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-card text-accent">
              <Upload className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-ink">Click to browse, or drop a file</span>
            <span className="text-[11px]">PNG, JPG or WebP · up to {MAX_MB} MB · cropped to a square</span>
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
          <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-muted">
          Used on printed invoices and in the sidebar. <strong className="text-ink">Saved immediately</strong> — it has its own endpoint, so it is
          not part of the unsaved changes below, and every change is recorded in the activity log.
        </p>
      )}
    </div>
  );
}
