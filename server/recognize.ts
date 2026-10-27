// OCR is used for index suggestions and identifying printed page numbers.
// Verse artwork always comes from the source; recognition never rewrites it.
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { createRequire } from 'node:module';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
let worker: Promise<Worker> | undefined;
let queue = Promise.resolve();

async function getWorker() {
  if (!worker) worker = (async () => {
    const langPath = path.resolve(process.env.DATA_DIR ?? 'data', 'ocr');
    await mkdir(langPath, { recursive: true });
    await Promise.all(['ara', 'urd'].map(async (lang) => {
      const source = require(`@tesseract.js-data/${lang}`) as { langPath: string };
      await copyFile(path.join(source.langPath, `${lang}.traineddata.gz`), path.join(langPath, `${lang}.traineddata.gz`));
    }));
    const w = await createWorker(['urd', 'ara'], 1, { langPath, cachePath: langPath, gzip: true });
    await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
    return w;
  })().catch((error) => { worker = undefined; throw error; });
  return worker;
}

export interface Recognition {
  name: string;
  confidence: number;
  numbers: { x: number; y: number; w: number; h: number }[];
}

export function recognize(png: Buffer): Promise<Recognition> {
  const job = queue.then(async () => {
    const w = await getWorker();
    const { data } = await w.recognize(png, {}, { text: true, blocks: true });
    const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
    const first = lines.find((l) => /[\u0621-\u06ff]/u.test(l.text) && !/^[\s\d\u0660-\u0669\u06f0-\u06f9]+$/u.test(l.text));
    const words = first?.text.trim().split(/\s+/).filter(Boolean) ?? [];
    const name = words.slice(0, words.length <= 6 ? 6 : 4).join(' ');
    const numbers = lines.filter((l) => /^[\s\d\u0660-\u0669\u06f0-\u06f9]+$/u.test(l.text.trim())).flatMap((l) => l.words)
      .filter((w) => w.confidence >= 55 && /^[\d\u0660-\u0669\u06f0-\u06f9]{1,4}$/u.test(w.text.trim()))
      .map(({ bbox: b }) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
    return { name, confidence: first?.confidence ?? 0, numbers };
  });
  queue = job.then(() => undefined, () => undefined);
  return job;
}

export async function closeRecognition() {
  const release = queue.then(async () => {
    const current = worker;
    worker = undefined;
    if (current) await (await current).terminate();
  });
  queue = release.catch(() => undefined);
  return release;
}
