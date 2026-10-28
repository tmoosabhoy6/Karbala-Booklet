import { arabicNumber, dateLine, raatTitle } from '../lib/hijri';
import { createContext, useContext, useMemo } from 'react';
import { EditContext, Editable, TextBoxView, TextEdits } from './Editable';
import { Booklet as Doc, CATEGORY_LABEL, City, ImageBlock, TEXT_COLORS, TextBox, VENUES, cityOf } from './model';
import { FihristItem, Layout, PAGE, Page, PlacedItem, imageWidthPt, ptPerPx } from './paginate';
import './booklet.css';
import { mediaSrc, openingSrc } from './media';
export { mediaSrc } from './media';

// Every piece of generated text is wrapped in <Editable>. Its id says where the
// text sits; ids starting cover./fihrist./line. are template wording that a new
// booklet keeps (see templateOverrides).

const A = '/assets';

/** Each city's artwork: Najaf's pages are Karbala's with the maroon turned
 * green (tools/build_najaf.py). The back page is the same for both. */
const THEMES: Record<City, { suffix: string; cityLogo?: string; faiz: string; ornament: string }> = {
  karbala: { suffix: '', cityLogo: 'logo-karbala.png', faiz: 'logo-faiz-husaini.png', ornament: 'end-ornament.png' },
  // The Najaf logo goes in as logo-najaf.png once its high-resolution copy is in.
  najaf: { suffix: '-najaf', faiz: 'logo-faiz-husaini-najaf.png', ornament: 'end-ornament-najaf.png' },
};
const Theme = createContext(THEMES.karbala);

const MediaContext = createContext<Record<string, string>>({});
/** On-screen width of a page in CSS px; unset when printing. */
const PreviewWidth = createContext<number | undefined>(undefined);

/** Page artwork is 2480×3508 px, the right size for print. The preview gets a
 * half-size copy and the browser switches to the full one once the zoom (and
 * screen density) can show more detail. The PDF always uses the full image. */
function Background({ name }: { name: 'cover-bg' | 'back-bg' | 'page-border' }) {
  const width = useContext(PreviewWidth);
  const { suffix } = useContext(Theme);
  const file = name === 'back-bg' ? name : `${name}${suffix}`;
  const full = `${A}/${file}.jpg`;
  if (!width) return <img className="bg" src={full} alt="" />;
  return <img className="bg" src={full} srcSet={`${A}/${file}.preview.jpg 1240w, ${full} 2480w`} sizes={`${Math.ceil(width)}px`} alt="" />;
}

/** The opening verse words, from a ready navy PNG. A plain image prints the
 * same everywhere; masks and hidden overlays showed as solid boxes. */
function OpeningWords({ block }: { block: ImageBlock }) {
  const assets = useContext(MediaContext);
  const r = block.opening;
  const src = openingSrc(block);
  if (!r || !src) return null;
  const s = Math.min(218 / r.w, 24 / r.h);
  return <img className="opening-words" src={assets[src] ?? src} style={{ width: `${r.w * s}pt`, height: `${r.h * s}pt` }} alt="Opening verse (click Edit text to replace its fihrist name)" />;
}

function Logos({ karbalaWidth, faizHeight }: { karbalaWidth: number; faizHeight: number }) {
  const { cityLogo, faiz } = useContext(Theme);
  return (
    <>
      {cityLogo && <img src={`${A}/${cityLogo}`} style={{ width: `${karbalaWidth}pt` }} alt="" />}
      <img src={`${A}/${faiz}`} style={{ height: `${faizHeight}pt` }} alt="" />
    </>
  );
}

function Cover({ doc }: { doc: Doc }) {
  const date = new Date(`${doc.date}T12:00:00`);
  const { cityLogo, faiz } = useContext(Theme);
  return (
    <>
      <Background name="cover-bg" />
      {/* Faiz-e-Husaini at the top-left corner; Karbala Mualla (or Najaf) centred above the title. */}
      <img className="cover-faiz" src={`${A}/${faiz}`} alt="" />
      {cityLogo && <img className="cover-karbala" src={`${A}/${cityLogo}`} alt="" />}
      <div className="cover-title main">
        <Editable id="cover.title" text={raatTitle(date)} />
      </div>
      <div className="cover-title sub">
        <Editable id="cover.sub" text="ماتم مجلس" />
      </div>
      <div className="cover-title date">
        <Editable id="cover.date" text={dateLine(date)} />
      </div>
      <div className="cover-location">
        <Editable id="cover.location" text={VENUES[doc.venue].location} />
      </div>
      <img className="abs" src={`${A}/sanat-1448.svg`} style={{ left: '144.86pt', top: '741.42pt', width: '219.6pt' }} alt="" />
    </>
  );
}

function FihristEntry({ item }: { item: FihristItem }) {
  const { ornament } = useContext(Theme);
  switch (item.kind) {
    case 'head':
      return (
        <div className="bar head">
          <Editable id="fihrist.head" text="فهرست" />
        </div>
      );
    case 'section':
      return (
        <div className="bar section">
          <Editable id={`fihrist.section.${item.index}`} text={item.title} />
        </div>
      );
    case 'cols':
      return (
        <div className="cols">
          <span>
            <Editable id="fihrist.col.tartib" text="ترتيب" />
          </span>
          <span>
            <Editable id="fihrist.col.kalam" text="كلام" />
          </span>
          <span>
            <Editable id="fihrist.col.page" text="الصفحة" />
          </span>
        </div>
      );
    case 'group': {
      const g = item.group;
      return (
        <div className="group">
          <a className={`tartib${g.first ? '' : ' cont'}`} href={`#${g.anchor}`}>
            <Editable id={`fihrist.cat.${g.category}`} text={CATEGORY_LABEL[g.category]} />
          </a>
          <div>
            {g.kalams.map((k) => (
              <a className="row" key={k.anchor} href={`#${k.anchor}`}>
                <span className="name">
                  <img src={`${A}/fihrist-bullet.png`} alt="" />
                  <span className="txt">
                    {k.fixed === 'all' ? (
                      // Fixed content is rebuilt on load, so its name is edited as an override.
                      <Editable id={`fihrist.name.${k.id}`} text={k.name} plain />
                    ) : (
                      <Editable text={k.name} plain fallback={k.opening?.opening ? <OpeningWords block={k.opening} /> : undefined} onCommit={(e, t) => e.kalamName(k.id, t)} />
                    )}
                  </span>
                </span>
                <span className="pg">
                  <Editable id={`pg.${k.id}`} text={arabicNumber(k.page)} />
                </span>
              </a>
            ))}
          </div>
        </div>
      );
    }
    case 'end':
      return (
        <div className="end">
          <img src={`${A}/${ornament}`} alt="" />
        </div>
      );
  }
}

function PageNumber({ n }: { n: number }) {
  return (
    <div className="page-number">
      <Editable id={`page.${n}`} text={arabicNumber(n)} />
    </div>
  );
}

function Fihrist({ page }: { page: Extract<Page, { kind: 'fihrist' }> }) {
  return (
    <>
      <Background name="page-border" />
      <div className="fihrist">
        {page.items.map((item, i) => (
          <FihristEntry key={i} item={item} />
        ))}
      </div>
      <PageNumber n={page.number} />
    </>
  );
}

function CroppedImage({ item }: { item: Extract<PlacedItem, { kind: 'block' }> & { block: ImageBlock } }) {
  const { block, crop, height, anchor, titleLink, imageRect, imageScale } = item;
  const assets = useContext(MediaContext);
  const s = imageScale ?? ptPerPx(block);
  const w = imageRect ? imageRect.w * s : imageWidthPt(block);
  const top = (imageRect?.y ?? crop?.[0] ?? 0) * s;
  const left = (imageRect?.x ?? 0) * s;
  const source = mediaSrc(block);
  return (
    <div className="block-img" id={anchor} style={{ width: `${w}pt`, height: `${height}pt`, marginTop: item.lead ? `${item.lead}pt` : undefined, marginBottom: item.gap === undefined ? undefined : `${item.gap}pt` }}>
      <img src={assets[source] ?? source} style={{ position: 'absolute', left: `${-left}pt`, top: `${-top}pt`, width: `${block.width * s}pt`, height: `${block.height * s}pt` }} alt="Verse artwork" />
      {titleLink && <a className="title-link" href="#fihrist" aria-label="فهرست" />}
    </div>
  );
}

function Item({ item }: { item: PlacedItem }) {
  const { ornament } = useContext(Theme);
  switch (item.kind) {
    case 'heading':
      return (
        <div className="heading" id={item.anchor}>
          <a href="#fihrist">
            <Editable id={`heading.${item.anchor}`} text={item.label} />
          </a>
        </div>
      );
    case 'block':
      if (item.block.kind === 'image') {
        return <CroppedImage item={{ ...item, block: item.block }} />;
      }
      const { id, text, sizePt } = item.block;
      return (
        <div className="block-text" id={item.anchor} style={{ fontSize: `${sizePt}pt` }}>
          {text.split('\n').slice(item.textStart, item.textEnd).map((line, row) => {
            const i = row + (item.textStart ?? 0);
            return (
            <div className="line" key={i}>
              {item.fixed ? (
                <Editable id={`line.${id}.${i}`} text={line} />
              ) : (
                <Editable text={line} onCommit={(e, t) => e.textLine(id, i, t)} />
              )}
            </div>
          ); })}
        </div>
      );
    case 'separator':
      return <div className="separator" />;
    case 'ornament':
      return (
        <div className="ornament">
          <img src={`${A}/${ornament}`} alt="" />
        </div>
      );
  }
}

function Back() {
  return (
    <>
      <Background name="back-bg" />
      <div className="back-logos">
        <Logos karbalaWidth={200} faizHeight={156} />
      </div>
    </>
  );
}

function PageBody({ page, doc }: { page: Page; doc: Doc }) {
  switch (page.kind) {
    case 'cover':
      return <Cover doc={doc} />;
    case 'fihrist':
      return <Fihrist page={page} />;
    case 'back':
      return <Back />;
    case 'content':
      return (
        <>
          <Background name="page-border" />
          <div className="content">
            {page.items.map((item, i) => (
              <Item key={i} item={item} />
            ))}
          </div>
          <PageNumber n={page.number} />
        </>
      );
  }
}

interface ViewProps {
  doc: Doc;
  layout: Layout;
  /** Given in the editor: page text becomes clickable and text boxes movable. */
  edits?: TextEdits;
  /** While set, a click on a page places a new text box there (x, y in pt). */
  onPlace?: (page: number, x: number, y: number) => void;
  assets?: Record<string, string>;
  /** Given in the editor: how wide a page shows on screen, in CSS px. */
  pageWidthPx?: number;
}

export function BookletView({ doc, layout, edits, onPlace, assets = {}, pageWidthPx }: ViewProps) {
  const city = cityOf(doc.venue);
  const ctx = useMemo(() => ({ overrides: doc.overrides ?? {}, edits, colors: TEXT_COLORS[city] }), [doc.overrides, edits, city]);
  const boxes = useMemo(() => {
    const byPage = new Map<number, TextBox[]>();
    for (const b of doc.textBoxes ?? []) byPage.set(b.page, [...(byPage.get(b.page) ?? []), b]);
    return byPage;
  }, [doc.textBoxes]);

  const place = (index: number) => (e: React.MouseEvent<HTMLElement>) => {
    if (!onPlace) return;
    // Placing takes the click, so the text under it is not opened for editing.
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const k = PAGE.width / r.width;
    onPlace(index, +((e.clientX - r.left) * k).toFixed(1), +((e.clientY - r.top) * k).toFixed(1));
  };

  return (
    <Theme.Provider value={THEMES[city]}>
    <EditContext.Provider value={ctx}>
      <MediaContext.Provider value={assets}>
      <PreviewWidth.Provider value={pageWidthPx}>
      <div className={`booklet ${city}${edits ? ' text-editing' : ''}${onPlace ? ' placing' : ''}`}>
        {layout.pages.map((page, i) => (
          <section
            key={i}
            className={`page${page.kind === 'cover' ? ' cover' : ''}`}
            id={page.kind === 'fihrist' && page.first ? 'fihrist' : undefined}
            data-page={page.kind === 'content' ? page.number : undefined}
            onClickCapture={onPlace && place(i)}
          >
            <PageBody page={page} doc={doc} />
            {boxes.get(i)?.map((b) => <TextBoxView key={b.id} box={b} />)}
          </section>
        ))}
      </div>
      </PreviewWidth.Provider>
      </MediaContext.Provider>
    </EditContext.Provider>
    </Theme.Provider>
  );
}
