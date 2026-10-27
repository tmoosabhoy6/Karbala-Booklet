import { useEffect, useState } from 'react';
import { mediaSrc } from '../booklet/media';
import { imageBlockFrom, type ImageBlock, type MediaMeta } from '../booklet/model';
import { api, type RestorationJob } from './api';

export function AIRestore({ block, onClose, onUse }: { block: ImageBlock; onClose: () => void; onUse: (meta: MediaMeta) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [job, setJob] = useState<RestorationJob | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  useEffect(() => { api.aiStatus().then((s) => setConfigured(s.configured)).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed') return;
    const timer = setTimeout(() => api.restorationJob(job.id).then(setJob).catch((e: Error) => setError(e.message)), 1500);
    return () => clearTimeout(timer);
  }, [job]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const start = async () => {
    setStarting(true); setError('');
    try { setJob(await api.restore(block.mediaId)); } catch (e) { setError((e as Error).message); }
    finally { setStarting(false); }
  };
  const useDraft = async () => {
    if (!job?.result) return;
    try {
      const meta = await api.media(job.result.id); // Also save its original to the browser backup.
      if (!meta) throw new Error('This draft is no longer available.');
      onUse(meta);
    } catch (e) { setError((e as Error).message); }
  };
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal ai-restore" role="dialog" aria-modal="true" aria-label="Restore lettering" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-bar"><h2>Restore lettering</h2><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
      <p>Restore blurry lettering using the booklet reference style. Compare every word and dot before using the draft.</p>
      {configured === false && <p role="status">OpenAI image restoration is not connected yet. Crisp vector cleanup and uniform sizing are already available.</p>}
      <div className="restore-comparison">
        <figure><figcaption>Original screenshot</figcaption><img src={`/api/media/${block.mediaId}/original`} alt="Original verse screenshot" /></figure>
        <figure><figcaption>Restored draft</figcaption>{job?.result ? <img src={mediaSrc(imageBlockFrom(job.result))} alt="Restored lettering to review" /> : <p role="status">{job?.status === 'restoring' ? 'Restoring lettering…' : job?.status === 'queued' ? 'Waiting for the previous restoration…' : 'The draft will appear here.'}</p>}</figure>
      </div>
      {(error || job?.error) && <p role="alert">{error || job?.error}</p>}
      <div className="modal-bar"><button className="ghost" onClick={onClose}>Keep original</button>{job?.status === 'ready' ? <button className="primary" onClick={useDraft}>Use restored lettering</button> : <button className="primary" disabled={!configured || starting || job?.status === 'queued' || job?.status === 'restoring'} onClick={start}>{starting ? 'Starting…' : 'Create AI draft'}</button>}</div>
    </section>
  </div>;
}
