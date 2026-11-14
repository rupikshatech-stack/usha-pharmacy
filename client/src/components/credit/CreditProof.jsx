import { useEffect, useState } from 'react';
import { creditService } from '../../services/creditService';
import { Modal, Skeleton } from '../common/ui';

/** The payment screenshot, fetched through the authenticated endpoint (the server only serves it to its owner or an administrator). */
export function ProofImage({ request: r, className = 'max-h-[28rem]' }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made = '';
    creditService
      .screenshot(r._id)
      .then((blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [r._id]);
  if (failed) return <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">The screenshot could not be loaded.</p>;
  if (!url) return <Skeleton className="h-64 w-full" />;
  return <img src={url} alt={`Payment screenshot of ${r.requestNo}`} className={`${className} w-full rounded-xl border border-line bg-subtle object-contain`} />;
}

/** Just the screenshot, from the table's "View" link. */
export default function CreditProof({ request: r, onClose }) {
  return (
    <Modal title={`Payment proof · ${r.requestNo}`} description={r.screenshot?.fileName} onClose={onClose}>
      <ProofImage request={r} />
    </Modal>
  );
}
