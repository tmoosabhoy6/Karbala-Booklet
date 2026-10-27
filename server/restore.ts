import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { addMedia, getMedia, MEDIA, type MediaMeta } from './store';
import { cleanScreenshot } from './ink';
import { heavyWork } from './resources';
import { letteringReferences, referenceBank, restorationInput, restorationPrompt, type LetteringScript } from './lettering';

const model = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2.5-flare';
const key = process.env.OPENAI_API_KEY;
const quality = 'high';
const requestedLimit = Number(process.env.AI_DAILY_LIMIT ?? 10);
const dailyLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 10;
export const restorationStatus = () => ({ configured: !!key, model, quality, dailyLimit, referenceBank });
type Job = { id: string; status: 'queued' | 'restoring' | 'ready' | 'failed'; result?: MediaMeta; error?: string; sourceId: string; script: LetteringScript };
const jobs = new Map<string, Job>(), cache = new Map<string, string>();
const queues = [Promise.resolve(), Promise.resolve()];
let nextSlot = 0, day = '', used = 0;

export async function startRestoration(mediaId: string, script: LetteringScript = 'auto'): Promise<Job> {
  if (!key) throw new Error('OpenAI image restoration is not connected yet.');
  const source = await getMedia(mediaId);
  if (!source) throw new Error('The original screenshot is missing. Add it again before restoring.');
  const fingerprint = createHash('sha256').update(`${mediaId}:${source.rev}:${model}:${quality}:${script}:bank-${referenceBank.version}:pipeline-3`).digest('hex');
  const existing = cache.get(fingerprint);
  if (existing && jobs.get(existing)?.status !== 'failed') return jobs.get(existing)!;
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; }
  if (used >= dailyLimit) throw new Error(`Today's ${dailyLimit} image restorations have been used. Try again tomorrow.`);
  if ([...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'restoring').length >= 3) throw new Error('Three restorations are already queued. Wait for one to finish.');
  const job: Job = { id: randomUUID(), status: 'queued', sourceId: mediaId, script };
  jobs.set(job.id, job); cache.set(fingerprint, job.id); used++;
  const slot = nextSlot++ % queues.length;
  const run = queues[slot].then(async () => {
    job.status = 'restoring';
    // Start with the untouched source and the user's crop/erase edits. Never
    // send an older threshold-traced SVG back to the model as its source.
    const clean = await heavyWork(async () => cleanScreenshot(await readFile(path.join(MEDIA, `${mediaId}.orig`)), source.edits, { ocr: false }));
    const prepared = await restorationInput(clean.png);
    const samples = await letteringReferences(script);
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', signal: AbortSignal.timeout(300_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, quality, background: 'transparent', output_format: 'png', size: prepared.size, n: 1,
        images: [prepared.image, ...samples.map((s) => s.png)].map((buffer) => ({ image_url: `data:image/png;base64,${buffer.toString('base64')}` })),
        prompt: restorationPrompt(script, clean.bands.length, samples),
      }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('The OpenAI connection needs an API key with image-editing access.');
      if (response.status === 429) throw new Error('OpenAI reports a credit or request limit. Check the API account before retrying.');
      console.error('Restoration provider error', response.status, response.headers.get('x-request-id'));
      throw new Error('The image provider could not complete this restoration. The original is unchanged.');
    }
    const result = await response.json() as { data?: { b64_json?: string }[] };
    const encoded = result.data?.[0]?.b64_json;
    if (!encoded) throw new Error('No restored image was returned. The original is unchanged.');
    const png = Buffer.from(encoded, 'base64');
    await heavyWork(async () => {
      const meta = await sharp(png).metadata();
      if (!meta.width || !meta.height || !meta.hasAlpha) throw new Error('The draft did not contain a transparent print image. The original is unchanged.');
      const stats = await sharp(png).stats();
      if (stats.channels[3]?.min !== 0) throw new Error('The draft still has an opaque background. The original is unchanged.');
      const check = await cleanScreenshot(png, { autoClean: false }, { ocr: false });
      if (check.bands.length !== clean.bands.length) throw new Error(`The draft changed the line count (${clean.bands.length} to ${check.bands.length}). It was rejected; the original is unchanged.`);
      // A row-count check catches omissions, not word accuracy. Human review
      // remains explicit; never overwrite the source with a model draft.
      if (check.width < clean.width || check.lineHeight < clean.lineHeight) throw new Error('The draft did not improve the available lettering resolution. The original is unchanged.');
    });
    job.result = await addMedia(png, undefined, { edits: { autoClean: false }, restoration: {
      sourceId: mediaId, sourceRev: source.rev, model, referenceVersion: referenceBank.version,
    } });
    job.status = 'ready';
  }).catch((error: Error) => { job.status = 'failed'; job.error = error.name === 'TimeoutError' ? 'Restoration took too long. The original is unchanged.' : error.message; });
  queues[slot] = run;
  return job;
}

export const restorationJob = (id: string) => jobs.get(id);
