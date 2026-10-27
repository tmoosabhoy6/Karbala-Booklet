import { Booklet } from './model';
import { mediaSrc, openingSrc } from './media';

export interface PrintPayload { doc: Booklet; assets: Record<string, string> }

/** Carry the very same cached artwork the user sees into the print browser.
 * A fresh server/browser must not depend on an old preview's HTTP cache. */
export async function printAssets(doc: Booklet): Promise<Record<string, string>> {
  const sources = [...new Set(Object.values(doc.kalams).flatMap((ks) => ks.flatMap((k) => k.blocks.flatMap((b) => b.kind === 'image' ? [mediaSrc(b), openingSrc(b)].filter((s): s is string => !!s) : []))))];
  return Object.fromEntries(await Promise.all(sources.map(async (src) => {
    const response = await fetch(src);
    if (!response.ok) throw new Error('A verse image is missing. Re-add its original screenshot before downloading.');
    const blob = await response.blob();
    const value = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read verse artwork. Please try again.'));
      reader.readAsDataURL(blob);
    });
    return [src, value];
  })));
}
