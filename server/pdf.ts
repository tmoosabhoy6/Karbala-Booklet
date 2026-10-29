// Printing a few pages at a time gives every piece its own copy of what the
// pieces share (the page backgrounds, the fonts). This keeps one of each.
import { createHash } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFRawStream, PDFRef, type PDFObject } from 'pdf-lib';

/** Identical streams (images, their masks, font files) merged into one:
 * references to a copy are pointed at the first, and the copies dropped. A
 * stream that refers to others (an image and its mask) matches only once
 * those are merged, hence the rounds. */
export function mergeDuplicateStreams(pdf: PDFDocument) {
  const { context } = pdf;
  for (let round = 0; round < 5; round++) {
    const first = new Map<string, PDFRef>();
    const copies = new Map<string, PDFRef>();
    const refs = new Map<string, PDFRef>();
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const key = createHash('sha256').update(obj.dict.toString()).update(obj.contents).digest('hex');
      const kept = first.get(key);
      if (kept) { copies.set(ref.tag, kept); refs.set(ref.tag, ref); }
      else first.set(key, ref);
    }
    if (!copies.size) return;
    const repoint = (obj: PDFObject) => {
      if (obj instanceof PDFDict) {
        for (const [name, value] of obj.entries()) {
          const kept = value instanceof PDFRef && copies.get(value.tag);
          if (kept) obj.set(name, kept);
          else repoint(value);
        }
      } else if (obj instanceof PDFArray) {
        for (let i = 0; i < obj.size(); i++) {
          const value = obj.get(i);
          const kept = value instanceof PDFRef && copies.get(value.tag);
          if (kept) obj.set(i, kept);
          else repoint(value);
        }
      } else if (obj instanceof PDFRawStream) repoint(obj.dict);
    };
    for (const [, obj] of context.enumerateIndirectObjects()) repoint(obj);
    repoint(context.trailerInfo.Root as PDFObject);
    for (const ref of refs.values()) context.delete(ref);
  }
}
