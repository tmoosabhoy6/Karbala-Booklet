import { Fragment, ReactNode } from 'react';

// Inline markup for booklet text:
//   {as}  → small «ع م» (alayhis-salaam), ع raised and م smaller below it
//   {saw} → small «صلع» (salla Allahu alayhi wa aalihi), same style
//   (Latin text) → set in a Latin face; Kanz al-Marjaan draws 0–9 as Arabic digits
const TOKEN = /(\{as\}|\{saw\}|\([A-Za-z][^)]*\))/;

function renderToken(tok: string, key: number): ReactNode {
  if (tok === '{as}') {
    return (
      <span className="honorific" key={key}>
        ع<span className="m">م</span>
      </span>
    );
  }
  if (tok === '{saw}') {
    return (
      <span className="honorific" key={key}>
        صلع
      </span>
    );
  }
  if (TOKEN.test(tok) && tok.startsWith('(')) {
    return (
      <span className="latin" key={key}>
        {tok}
      </span>
    );
  }
  return <Fragment key={key}>{tok}</Fragment>;
}

export function RichText({ text }: { text: string }) {
  return <>{text.split(TOKEN).filter(Boolean).map(renderToken)}</>;
}

/** Plain-text form (fihrist names, PDF title): markers dropped. */
export const stripMarkup = (text: string) => text.replace(/\{as\}|\{saw\}/g, '').replace(/\s+/g, ' ').trim();
