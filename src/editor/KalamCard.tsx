import { useRef, useState } from 'react';
import { mediaSrc } from '../booklet/Booklet';
import { Block, Category, Defaults, Kalam, imageBlockFrom, isBuiltinMedia, uid } from '../booklet/model';
import { api } from './api';
import { BookletState, sameBlocks } from './useBooklet';
import { LibrarySearch } from './LibrarySearch';
import type { LibraryHit } from './library';

interface Props {
  category: Category;
  kalam: Kalam;
  index: number;
  count: number;
  active: boolean;
  state: BookletState;
  defaults: Defaults;
  onActivate: () => void;
  onEditImage: (block: Extract<Block, { kind: 'image' }>) => void;
  onRestoreImage: (block: Extract<Block, { kind: 'image' }>) => void;
  uploads: number;
  /** Library images still being made for this card. */
  fetching: number;
  onUpload: (files: File[]) => void;
  onLibrary: (hit: LibraryHit) => void;
}

// Phones have no ⌘V or drag and drop: the drop area just opens the photo picker.
const TOUCH = matchMedia('(pointer: coarse)').matches;

const move = <T,>(arr: T[], from: number, to: number) => {
  const out = [...arr];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
};

export function KalamCard({ category, kalam, index, count, active, state, defaults, onActivate, onEditImage, onRestoreImage, uploads, fetching, onUpload, onLibrary }: Props) {
  const { updateKalam, updateKalams, pin, unpin } = state;
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [editingNo, setEditingNo] = useState<number | null>(null);

  const pinned = kalam.slot ? defaults[kalam.slot] : undefined;
  const pinStale = pinned && (pinned.name !== kalam.name || !sameBlocks(pinned.blocks, kalam.blocks));
  const setBlocks = (fn: (b: Block[]) => Block[]) => updateKalam(category, kalam.id, (k) => ({ ...k, blocks: fn(k.blocks) }));

  const reorderBlock = (from: number, to: number) => setBlocks((b) => move(b, from, to));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) onUpload(files);
  };

  return (
    <div
      className={`kalam${active ? ' active' : ''}`}
      onMouseDown={onActivate}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="kalam-head">
        <span className="kalam-no" title="Order in this section">{index + 1}</span>
        <input
          className="kalam-name"
          dir="rtl"
          value={kalam.name}
          placeholder={kalam.blocks[0]?.kind === 'image' && kalam.blocks[0].opening ? 'Opening verse fills fihrist automatically · type to replace' : 'Fihrist name: first words of the first verse'}
          onChange={(e) => updateKalam(category, kalam.id, (k) => ({ ...k, name: e.target.value }))}
        />
        {pinned && !pinStale && <span className="default-tag" title="Starts every new booklet (★ to unpin)">Default</span>}
        <div className="kalam-tools">
          <button title="Move up" disabled={index === 0} onClick={() => updateKalams(category, (ks) => move(ks, index, index - 1))}>
            ↑
          </button>
          <button title="Move down" disabled={index === count - 1} onClick={() => updateKalams(category, (ks) => move(ks, index, index + 1))}>
            ↓
          </button>
          <button
            className={`pin${pinned ? ' on' : ''}${pinStale ? ' stale' : ''}`}
            title={pinned ? (pinStale ? 'Pinned default differs: click to update it' : 'Default for new booklets: click to unpin') : 'Pin as default for new booklets'}
            onClick={() => (pinned && !pinStale ? unpin(kalam.slot!) : pin(category, kalam))}
          >
            {pinned ? '★' : '☆'}
          </button>
          <button
            title="Remove kalam from this booklet"
            onClick={() => {
              if (!kalam.blocks.length || confirm('Remove this kalam and its screenshots from this booklet?')) updateKalams(category, (ks) => ks.filter((k) => k.id !== kalam.id));
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="blocks">
        {kalam.blocks.map((b, i) => (
          <div
            key={b.id}
            className={`block${dragFrom === i ? ' dragging' : ''}`}
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(i));
            }}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              e.stopPropagation();
              reorderBlock(dragFrom, i);
              setDragFrom(null);
            }}
          >
            {editingNo === i ? (
              <input
                className="order-input"
                type="number"
                autoFocus
                defaultValue={i + 1}
                min={1}
                max={kalam.blocks.length}
                onBlur={(e) => {
                  reorderBlock(i, Number(e.target.value) - 1);
                  setEditingNo(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingNo(null);
                }}
              />
            ) : (
              <button className="order" title="Click to change the order (or drag)" onClick={() => setEditingNo(i)}>
                {i + 1}
              </button>
            )}
            {b.kind === 'image' ? (
              <img className="thumb" src={mediaSrc(b)} alt="" draggable={false} onDoubleClick={() => !isBuiltinMedia(b.mediaId) && onEditImage(b)} />
            ) : (
              <textarea
                className="text-block"
                dir="rtl"
                value={b.text}
                placeholder="Type in Kanz al-Marjaan… ({as} = ع م, {saw} = صلع)"
                onChange={(e) => setBlocks((bs) => bs.map((x) => (x.id === b.id ? { ...x, text: e.target.value } : x)))}
              />
            )}
            <div className="block-tools">
              {b.kind === 'image' && (
                <>
                  {/* Built-in default pages are cleaned with the app and shared: no crop/erase or AI. */}
                  {!isBuiltinMedia(b.mediaId) && (
                    <>
                      <button title="Crop / erase marks" onClick={() => onEditImage(b)}>
                        ✎
                      </button>
                      <button title="Restore blurry lettering with AI" onClick={() => onRestoreImage(b)}>AI</button>
                    </>
                  )}
                  <button
                    title="Smaller text"
                    onClick={() => setBlocks((bs) => bs.map((x) => (x.id === b.id && x.kind === 'image' ? { ...x, scale: Math.max(0.5, +(x.scale - 0.05).toFixed(2)) } : x)))}
                  >
                    −
                  </button>
                  <span className="scale">{Math.round(b.scale * 100)}%</span>
                  <button
                    title="Larger text"
                    onClick={() => setBlocks((bs) => bs.map((x) => (x.id === b.id && x.kind === 'image' ? { ...x, scale: Math.min(1.6, +(x.scale + 0.05).toFixed(2)) } : x)))}
                  >
                    +
                  </button>
                </>
              )}
              <button title="Remove" onClick={() => setBlocks((bs) => bs.filter((x) => x.id !== b.id))}>
                ✕
              </button>
            </div>
            {b.kind === 'image' && !!b.warnings?.length && <small className="image-warning">{b.warnings.join(' ')}</small>}
          </div>
        ))}
        {Array.from({ length: uploads }, (_, i) => (
          <div className="block pending" key={`p${i}`}>
            <span className="spinner" /> Cleaning screenshot…
          </div>
        ))}
        {fetching > 0 && (
          <div className="block pending">
            <span className="spinner" /> Adding from Zikre Husain… {fetching > 1 && `(${fetching} parts to go)`}
          </div>
        )}
      </div>

      {!kalam.blocks.length && !fetching && <LibrarySearch category={category} placeholder="Fill this kalam from Zikre Husain: type its first words" onPick={onLibrary} />}

      <div
        className={`dropzone${dragOver ? ' over' : ''}${active ? ' armed' : ''}`}
        onClick={() => {
          onActivate();
          fileInput.current?.click();
        }}
      >
        {TOUCH ? 'Tap to add screenshots' : active ? <><b>⌘V to paste</b> · drop or choose screenshots</> : 'Click here, then ⌘V to paste · drop or choose screenshots'}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onUpload(files);
          }}
        />
      </div>
      <button className="link" onClick={() => setBlocks((bs) => [...bs, { kind: 'text', id: uid(), text: '', sizePt: 20 }])}>
        + Typed text
      </button>
    </div>
  );
}

/** Upload files one by one (in order) and append them to a kalam. */
export async function uploadInto(files: File[], append: (b: Block) => void, onProgress: (n: number) => void) {
  let left = files.length;
  onProgress(left);
  for (const f of files) {
    try {
      const m = await api.upload(f);
      append(imageBlockFrom(m));
    } catch (e) {
      alert(`Could not process ${f.name || 'screenshot'}: ${(e as Error).message}`);
    }
    onProgress(--left);
  }
}
