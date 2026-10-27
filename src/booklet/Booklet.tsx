import { Fragment } from 'react';
import { arabicNumber, dateLine, raatTitle } from '../lib/hijri';
import { Booklet as Doc, CATEGORY_LABEL, VENUES } from './model';
import { Layout, Page, PlacedItem } from './paginate';
import './booklet.css';

const A = '/assets';

function Location({ text }: { text: string }) {
  // `{as}` marks the small raised «ع م» honorific; Latin runs keep LTR order.
  const [before, after = ''] = text.split('{as}');
  const latin = /\(([A-Za-z].*)\)$/.exec(after);
  const arabic = latin ? after.slice(0, latin.index) : after;
  return (
    <span>
      {before}
      {text.includes('{as}') && (
        <span className="honorific">
          ع<span className="m">م</span>
        </span>
      )}
      {arabic}
      {latin && <span className="latin">({latin[1]})</span>}
    </span>
  );
}

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
        <Location text={VENUES[doc.venue].location} />
      </div>
      <img className="abs" src={`${A}/sanat-1448.svg`} style={{ left: '144.86pt', top: '741.42pt', width: '219.6pt' }} alt="" />
    </section>
  );
}

function Fihrist({ layout }: { layout: Layout }) {
  return (
    <section className="page" id="fihrist">
      <img className="bg" src={`${A}/page-border.jpg`} alt="" />
      <div className="fihrist">
        <div className="bar head">فهرست</div>
        {layout.fihrist.map((section, si) => (
          <Fragment key={si}>
            <div className="bar section">{section.title}</div>
            {si === 0 && (
              <div className="cols">
                <span>ترتيب</span>
                <span>كلام</span>
                <span>الصفحة</span>
              </div>
            )}
            {section.rows.map((row) => (
              <div className="group" key={row.entryAnchor}>
                <a className="tartib" href={`#${row.entryAnchor}`}>
                  {CATEGORY_LABEL[row.category]}
                </a>
                <div>
                  {row.kalams.map((k) => (
                    <a className="row" key={k.anchor} href={`#${k.anchor}`}>
                      <span className="name">
                        <img src={`${A}/fihrist-bullet.png`} alt="" />
                        {k.name}
                      </span>
                      <span className="pg">{arabicNumber(k.page)}</span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </Fragment>
        ))}
        <div className="end">
          <img src={`${A}/end-ornament.png`} alt="" />
        </div>
      </div>
      <div className="page-number">{arabicNumber(1)}</div>
    </section>
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
        return (
          <img
            className="block-img"
            id={item.anchor}
            src={item.block.src}
            style={{ width: `${item.block.widthPt}pt`, height: `${item.height}pt` }}
            alt=""
          />
        );
      }
      return (
        <div className="block-text" id={item.anchor} style={{ fontSize: `${item.block.sizePt}pt`, color: item.block.color }}>
          {item.block.text}
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

function PageView({ page, doc, layout }: { page: Page; doc: Doc; layout: Layout }) {
  switch (page.kind) {
    case 'cover':
      return <Cover doc={doc} />;
    case 'fihrist':
      return <Fihrist layout={layout} />;
    case 'back':
      return <Back />;
    case 'content':
      return (
        <section className="page">
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
        <PageView key={i} page={page} doc={doc} layout={layout} />
      ))}
    </div>
  );
}
