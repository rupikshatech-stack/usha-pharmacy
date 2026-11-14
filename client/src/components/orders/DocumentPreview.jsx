import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { cx } from '../common/ui';

/**
 * A preview of the invoice the user is working from: an image is shown as a picture, a PDF in a sandboxed frame. `file` is a File (just chosen) or a
 * Blob (fetched from the server). The temporary address is released when the preview goes away.
 */
export default function DocumentPreview({ file, type, name, className }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) return undefined;
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a preview address must be made and released with the file
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl('');
    };
  }, [file]);
  const kind = type || file?.type;
  return (
    <div className={cx('overflow-hidden rounded-xl border border-line bg-subtle', className)} aria-label="Document preview">
      {!url ? (
        <div className="grid h-64 place-items-center text-sm text-muted">
          <span className="flex items-center gap-2">
            <FileText className="h-4 w-4" aria-hidden="true" /> Preparing the preview…
          </span>
        </div>
      ) : kind === 'application/pdf' ? (
        <iframe title={`Preview of ${name || 'the invoice'}`} src={url} sandbox="" className="h-[28rem] w-full bg-white lg:h-[34rem]" />
      ) : (
        <img src={url} alt={`Preview of ${name || 'the invoice'}`} className="max-h-[34rem] w-full object-contain" />
      )}
    </div>
  );
}
