import { arabicNumber, dateLine, raatTitle } from '../lib/hijri';
import { Booklet as Doc, CATEGORY_LABEL, ImageBlock, VENUES } from './model';
import { FihristItem, Layout, Page, PlacedItem, imageWidthPt, ptPerPx } from './paginate';
import { RichText } from './RichText';
import './booklet.css';

const A = '/assets';

export const mediaSrc = (b: ImageBlock) => `/media/${b.mediaId}.svg?v=${b.rev}`;

function Logos({ karbalaWidth, faizHeight }: { karbalaWidth: number; faizHeight: number }) {
  return (
    <>
      <img src={`${A}/logo-karbala.svg`} style={{ width: `${karbalaWidth}pt` }} alt="" />
      <img src={`${A}/logo-faiz-husaini.png`} style={{ height: `${faizHeight}pt` }} alt="" />
    </>
  );
}

function Cover({ doc }: { doc: Doc }) {
  const date = new Date(`${doc.date}T12:00:00`);
  return (
    <section className="page cover">
      <img className="bg" src={`${A}/cover-bg.jpg`} alt="" />
      <div className="cover-logos">
        <Logos karbalaWidth={132} faizHeight={102} />
      </div>
      <div className="cover-title main">{raatTitle(date)}</div>
      <div className="cover-title sub">ماتم مجلس</div>
      <div className="cover-title date">{dateLine(date)}</div>
      <div className="cover-location">
        <RichText text={VENUES[doc.venue].location} />
      </div>
      <img className="abs" src={`${A}/sanat-1448.svg`} style={{ left: '144.86pt', top: '741.42pt', width: '219.6pt' }} alt="" />
    </section>
  );
}

function FihristEntry({ item }: { item: FihristItem }) {
  switch (item.kind) {
    case 'head':
      return <div className="bar head">فهرست</div>;
    case 'section':
      return <div className="bar section">{item.title}</div>;
    case 'cols':
      return (
        <div className="cols">
          <span>ترتيب</span>
          <span>كلام</span>
          <span>الصفحة</span>
        </div>
      );
    case 'group': {
      const g = item.group;
      return (
        <div className="group">
          <a className={`tartib${g.first ? '' : ' cont'}`} href={`#${g.anchor}`}>
            {CATEGORY_LABEL[g.category]}
          </a>
          <div>
            {g.kalams.map((k) => (
              <a className="row" key={k.anchor} href={`#${k.anchor}`}>
                <span className="name">
                  <img src={`${A}/fihrist-bullet.png`} alt="" />
                  <span className="txt">{k.name}</span>
                </span>
                <span className="pg">{arabicNumber(k.page)}</span>
              </a>
            ))}
          </div>
        </div>
      );
    }
    case 'end':
      return (
        <div className="end">
          <img src={`${A}/end-ornament.png`} alt="" />
        </div>
      );
  }
}

function Fihrist({ page }: { page: Extract<Page, { kind: 'fihrist' }> }) {
  return (
    <section className="page" id={page.first ? 'fihrist' : undefined}>
      <img className="bg" src={`${A}/page-border.jpg`} alt="" />
      <div className="fihrist">
        {page.items.map((item, i) => (
          <FihristEntry key={i} item={item} />
        ))}
      </div>
      <div className="page-number">{arabicNumber(page.number)}</div>
    </section>
  );
}

function CroppedImage({ block, crop, height, anchor, titleLink }: { block: ImageBlock; crop?: [number, number]; height: number; anchor?: string; titleLink?: boolean }) {
  const w = imageWidthPt(block);
  const s = ptPerPx(block);
  const top = crop ? crop[0] * s : 0;
  return (
    <div className="block-img" id={anchor} style={{ width: `${w}pt`, height: `${height}pt` }}>
      <img src={mediaSrc(block)} style={{ width: `${w}pt`, height: `${block.height * s}pt`, marginTop: `${-top}pt` }} alt="" />
      {titleLink && <a className="title-link" href="#fihrist" aria-label="فهرست" />}
    </div>
  );
}

function Item({ item }: { item: PlacedItem }) {
  switch (item.kind) {
    case 'heading':
      return (
        <div className="heading" id={item.anchor}>
          <a href="#fihrist">{item.label}</a>
        </div>
      );
    case 'block':
      if (item.block.kind === 'image') {
        return <CroppedImage block={item.block} crop={item.crop} height={item.height} anchor={item.anchor} titleLink={item.titleLink} />;
      }
      return (
        <div className="block-text" id={item.anchor} style={{ fontSize: `${item.block.sizePt}pt` }}>
          {item.block.text.split('\n').map((line, i) => (
            <div className="line" key={i}>
              <RichText text={line} />
            </div>
          ))}
        </div>
      );
    case 'separator':
      return <div className="separator" />;
    case 'ornament':
      return (
        <div className="ornament">
          <img src={`${A}/end-ornament.png`} alt="" />
        </div>
      );
  }
}

function Back() {
  return (
    <section className="page">
      <img className="bg" src={`${A}/back-bg.jpg`} alt="" />
      <div className="back-logos">
        <Logos karbalaWidth={200} faizHeight={156} />
      </div>
    </section>
  );
}

function PageView({ page, doc }: { page: Page; doc: Doc }) {
  switch (page.kind) {
    case 'cover':
      return <Cover doc={doc} />;
    case 'fihrist':
      return <Fihrist page={page} />;
    case 'back':
      return <Back />;
    case 'content':
      return (
        <section className="page" data-page={page.number}>
          <img className="bg" src={`${A}/page-border.jpg`} alt="" />
          <div className="content">
            {page.items.map((item, i) => (
              <Item key={i} item={item} />
            ))}
          </div>
          <div className="page-number">{arabicNumber(page.number)}</div>
        </section>
      );
  }
}

export function BookletView({ doc, layout }: { doc: Doc; layout: Layout }) {
  return (
    <div className="booklet">
      {layout.pages.map((page, i) => (
        <PageView key={i} page={page} doc={doc} />
      ))}
    </div>
  );
}
