// Typing on the pages: click any generated text (titles, fihrist, headings,
// page numbers) to retype it, and place free text boxes. Outside the editor
// (the PDF render) there are no `edits`, and the saved changes are only shown.
import { CSSProperties, ReactNode, createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TEXT_COLORS, TextBox, TextOverride } from './model';
import { PAGE } from './paginate';
import { RichText, stripMarkup } from './RichText';

export interface TextEdits {
  /** Replace generated text `from` at `key`; the original text at scale 1 removes the edit. */
  override(key: string, from: string, text: string, scale: number): void;
  kalamName(kalamId: string, name: string): void;
  textLine(blockId: string, line: number, text: string): void;
  /** Change a text box, or remove it with `null`. */
  box(id: string, patch: Partial<TextBox> | null): void;
}

interface Ctx {
  overrides: Record<string, TextOverride>;
  edits?: TextEdits;
}

export const EditContext = createContext<Ctx>({ overrides: {} });

const SCALE_STEP = 0.05;

/** Floating tools above the field being edited, outside the page so it is never clipped. */
function Toolbar({ anchor, hint, children }: { anchor: React.RefObject<HTMLElement>; hint: string; children: ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const next = { left: Math.round(r.left + r.width / 2), top: Math.round(Math.max(4, r.top - 40)) };
      setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  });
  if (!pos) return null;
  return createPortal(
    // Buttons act on mousedown so the field keeps focus.
    <div className="text-tools" style={pos} onMouseDown={(e) => e.preventDefault()}>
      {children}
      <span className="hint">{hint}</span>
    </div>,
    document.body,
  );
}

interface FieldProps {
  initial: string;
  multiline?: boolean;
  className?: string;
  style?: CSSProperties;
  fieldRef: React.RefObject<HTMLSpanElement>;
  onSave: (text: string) => void;
  onCancel: () => void;
}

/** Reads a field's text: one line, or lines joined by \n. */
export const fieldText = (el: HTMLElement | null, multiline = false) => {
  const t = (el?.innerText ?? '').replace(/ /g, ' ');
  return multiline ? t.replace(/\n+$/, '') : t.replace(/\s*\n\s*/g, ' ').trim();
};

/** Plain-text, in-place field. Enter saves (Shift+Enter: new line when multiline); Esc cancels. */
function Field({ initial, multiline, className, style, fieldRef, onSave, onCancel }: FieldProps) {
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = fieldRef.current!;
    el.innerText = initial;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // Set once: React must not manage the content while it is being typed.
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(fieldText(fieldRef.current, multiline));
    else onCancel();
  };
  return (
    <span
      ref={fieldRef}
      className={`editing${className ? ` ${className}` : ''}`}
      style={style}
      contentEditable="plaintext-only"
      spellCheck={false}
      onClick={(e) => {
        // Text inside fihrist links and headings must not follow the link.
        e.preventDefault();
        e.stopPropagation();
      }}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

type EditableProps = { text: string; plain?: boolean; fallback?: ReactNode } & (
  | { id: string; onCommit?: never }
  | { id?: never; onCommit: (edits: TextEdits, text: string) => void }
);

/**
 * Generated text that can be retyped. With `id`, the typed text is kept as an
 * override of `text`; with `onCommit`, it is written back to the source (a
 * kalam's name, a typed-text line). `plain` drops the {as}/{saw} marks.
 */
export function Editable({ id, text, plain, onCommit, fallback }: EditableProps) {
  const { overrides, edits } = useContext(EditContext);
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLSpanElement>(null);
  // Set by "↺ Original", so the field's closing blur does not save over it.
  const closed = useRef(false);
  const o = id ? overrides[id] : undefined;
  const live = o && o.from === text ? o : undefined;
  const shown = live ? live.text : text;
  const scale = live?.scale ?? 1;
  const style = scale !== 1 ? { fontSize: `${Math.round(scale * 100)}%` } : undefined;
  const view = !shown && fallback ? fallback : plain ? stripMarkup(shown) : <RichText text={shown} />;

  if (!edits) return style ? <span style={style}>{view}</span> : <>{view}</>;

  const save = (t: string, s = scale) => {
    if (t === shown && s === scale) return;
    if (id) edits.override(id, text, t, s);
    else onCommit!(edits, t);
  };

  if (editing) {
    return (
      <>
        <Field
          initial={shown}
          style={style}
          fieldRef={field}
          onSave={(t) => {
            if (!closed.current) save(t);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
        {id && (
          <Toolbar anchor={field} hint="Enter to save · Esc to cancel">
            <button title="Smaller" onClick={() => save(fieldText(field.current), Math.max(0.3, +(scale - SCALE_STEP).toFixed(2)))}>
              A−
            </button>
            <span className="val">{Math.round(scale * 100)}%</span>
            <button title="Larger" onClick={() => save(fieldText(field.current), Math.min(3, +(scale + SCALE_STEP).toFixed(2)))}>
              A+
            </button>
            <button
              title="Back to the original text"
              disabled={!live}
              onClick={() => {
                closed.current = true;
                edits.override(id, text, text, 1);
                setEditing(false);
              }}
            >
              ↺ Original
            </button>
          </Toolbar>
        )}
      </>
    );
  }

  return (
    <span
      className={`editable${live ? ' edited' : ''}${shown ? '' : ' empty'}`}
      style={style}
      title={live ? `Edited (was: ${stripMarkup(text)}). Click to change` : 'Click to edit'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        closed.current = false;
        setEditing(true);
      }}
    >
      {view}
    </span>
  );
}

const SIZE_STEP = 1;

/** A free text box: click to type, drag to move. */
export function TextBoxView({ box }: { box: TextBox }) {
  const { edits } = useContext(EditContext);
  const [editing, setEditing] = useState(!box.text && !!edits);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const field = useRef<HTMLSpanElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const start = useRef<{ cx: number; cy: number; k: number; moved: boolean } | null>(null);

  // A box opened for typing and left empty is removed.
  useEffect(() => {
    if (!editing && !box.text) edits?.box(box.id, null);
  }, [editing, box.text, box.id, edits]);

  const x = drag?.x ?? box.x;
  const y = drag?.y ?? box.y;
  const style: CSSProperties = { left: `${x}pt`, top: `${y}pt`, fontSize: `${box.sizePt}pt`, color: box.color };
  const lines = box.text.split('\n').map((l, i) => (
    <div key={i}>
      <RichText text={l} />
    </div>
  ));

  if (!edits) {
    return (
      <div className="text-box" style={style}>
        {lines}
      </div>
    );
  }

  if (editing) {
    return (
      <div className="text-box on" style={style}>
        <Field
          initial={box.text}
          multiline
          fieldRef={field}
          onSave={(t) => {
            if (t !== box.text) edits.box(box.id, { text: t });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
        <Toolbar anchor={field} hint="Enter to save · Shift+Enter new line · Esc to cancel">
          <button title="Smaller" onClick={() => edits.box(box.id, { sizePt: Math.max(6, box.sizePt - SIZE_STEP) })}>
            A−
          </button>
          <span className="val">{box.sizePt}pt</span>
          <button title="Larger" onClick={() => edits.box(box.id, { sizePt: Math.min(120, box.sizePt + SIZE_STEP) })}>
            A+
          </button>
          {TEXT_COLORS.map((c) => (
            <button key={c} className={`swatch${c === box.color ? ' on' : ''}`} style={{ background: c }} title="Colour" onClick={() => edits.box(box.id, { color: c })} />
          ))}
          <button title="Delete this text box" onClick={() => edits.box(box.id, null)}>
            🗑
          </button>
        </Toolbar>
      </div>
    );
  }

  // Pointer handling: a click opens the box for typing, a drag moves it.
  return (
    <div
      ref={el}
      className={`text-box editable${drag ? ' dragging' : ''}`}
      style={style}
      title="Click to edit, drag to move"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const page = el.current!.closest('.page')!.getBoundingClientRect();
        start.current = { cx: e.clientX, cy: e.clientY, k: PAGE.width / page.width, moved: false };
        el.current!.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dx = e.clientX - s.cx;
        const dy = e.clientY - s.cy;
        if (!s.moved && Math.hypot(dx, dy) < 3) return;
        s.moved = true;
        setDrag({ x: +(box.x + dx * s.k).toFixed(1), y: +(box.y + dy * s.k).toFixed(1) });
      }}
      onPointerUp={() => {
        const s = start.current;
        start.current = null;
        if (s?.moved && drag) edits.box(box.id, drag);
        else if (!s?.moved) setEditing(true);
        setDrag(null);
      }}
    >
      {lines}
    </div>
  );
}
