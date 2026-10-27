// Crop / erase editor: draw boxes on the original screenshot. Erase removes
// stray marks (verse-number badges, timestamps, app UI); crop keeps only the
// part you want. The server re-cleans and re-traces on Apply.
import { useEffect, useRef, useState } from 'react';
import type { ImageBlock, MediaMeta } from '../booklet/model';
import { api, Edits, Rect } from './api';

interface Props {
  block: ImageBlock;
  onClose: () => void;
  onApplied: (m: MediaMeta) => void;
}

export function ImageEditor({ block, onClose, onApplied }: Props) {
  const [edits, setEdits] = useState<Edits>({ erase: [] });
  const [mode, setMode] = useState<'erase' | 'crop'>('erase');
  const [draft, setDraft] = useState<Rect | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    api.media(block.mediaId).then((m) => m && setEdits({ erase: m.edits?.erase ?? [], crop: m.edits?.crop, autoClean: m.edits?.autoClean }));
  }, [block.mediaId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Screen ↔ original-pixel conversion.
  const toPx = (e: React.MouseEvent) => {
    const r = img.current!.getBoundingClientRect();
    const k = natural!.w / r.width;
    return { x: Math.max(0, Math.min(natural!.w, (e.clientX - r.left) * k)), y: Math.max(0, Math.min(natural!.h, (e.clientY - r.top) * k)) };
  };
  const pct = (r: Rect) =>
    natural && { left: `${(r.x / natural.w) * 100}%`, top: `${(r.y / natural.h) * 100}%`, width: `${(r.w / natural.w) * 100}%`, height: `${(r.h / natural.h) * 100}%` };

  const down = (e: React.MouseEvent) => {
    if (!natural) return;
    e.preventDefault();
    start.current = toPx(e);
    setDraft({ ...start.current, w: 0, h: 0 });
  };
  const moveMouse = (e: React.MouseEvent) => {
    if (!start.current) return;
    const p = toPx(e);
    const s = start.current;
    setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const up = () => {
    if (draft && draft.w > 3 && draft.h > 3) {
      setEdits((ed) => (mode === 'crop' ? { ...ed, crop: draft } : { ...ed, erase: [...(ed.erase ?? []), draft] }));
    }
    start.current = null;
    setDraft(null);
  };

  const apply = async () => {
    setBusy(true);
    try {
      onApplied(await api.edit(block.mediaId, edits));
      onClose();
    } catch (e) {
      alert((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-bar">
          <label><input type="checkbox" checked={edits.autoClean !== false} onChange={(e) => setEdits((v) => ({ ...v, autoClean: e.target.checked }))} /> Remove stray marks automatically</label>
          <div className="seg">
            <button className={mode === 'erase' ? 'on' : ''} onClick={() => setMode('erase')}>
              Erase marks
            </button>
            <button className={mode === 'crop' ? 'on' : ''} onClick={() => setMode('crop')}>
              Crop
            </button>
          </div>
          <span className="hint">{mode === 'erase' ? 'Drag a box over anything that should not print.' : 'Drag a box around the part to keep.'}</span>
          <button className="ghost" onClick={() => setEdits({ erase: [] })}>
            Reset
          </button>
        </div>
        <div className="canvas">
          <div className="stage" onMouseDown={down} onMouseMove={moveMouse} onMouseUp={up} onMouseLeave={up}>
            <img
              ref={img}
              src={`/api/media/${block.mediaId}/original`}
              alt=""
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            />
            {edits.crop && <div className="box crop" style={pct(edits.crop)!} />}
            {edits.erase?.map((r, i) => (
              <div className="box erase" key={i} style={pct(r)!}>
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setEdits((ed) => ({ ...ed, erase: ed.erase!.filter((_, j) => j !== i) }))}
                >
                  ✕
                </button>
              </div>
            ))}
            {draft && <div className={`box ${mode}`} style={pct(draft)!} />}
          </div>
        </div>
        <div className="modal-bar end">
          {edits.crop && (
            <button className="ghost" onClick={() => setEdits((ed) => ({ ...ed, crop: undefined }))}>
              Remove crop
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={apply} disabled={busy}>
            {busy ? 'Cleaning…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
