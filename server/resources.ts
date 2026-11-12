// OCR/tracing and Chromium must never hold their peak allocations together
// on the 512 MB host. Both pipelines enter this same queue.
let queue = Promise.resolve();
let waiting = 0;
let release: (() => Promise<void>) | null = null;
const onStuck: (() => Promise<void> | void)[] = [];
/** Called before work other than printing (it closes the warm browser). */
export const beforeOtherHeavyWork = (fn: () => Promise<void>) => { release = fn; };
/** Called when a job overruns its time: stop whatever it was running (the
 * OCR worker, the library renderer, Chromium), so the next job starts clean. */
export const whenHeavyWorkIsStuck = (fn: () => Promise<void> | void) => { onStuck.push(fn); };
/** Jobs queued and not yet started (a PDF made ahead gives way to them). */
export const heavyWaiting = () => waiting;

/** How long one job may hold the queue: cleaning a screenshot takes seconds
 * to a minute on the free host, a long booklet's PDF a few minutes. */
const LIMIT = Number(process.env.HEAVY_TIMEOUT_MS ?? 5 * 60_000);
const PRINT_LIMIT = Number(process.env.PRINT_TIMEOUT_MS ?? 15 * 60_000);
export class HeavyTimeout extends Error {}

export function heavyWork<T>(run: () => Promise<T>, options: { print?: boolean } = {}): Promise<T> {
  if (!options.print) waiting++;
  const job = queue.then(async () => {
    let timer: NodeJS.Timeout | undefined;
    const overrun = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HeavyTimeout(options.print ? 'Making the PDF took too long. Try again.' : 'The server took too long with this image. Try again.')), options.print ? PRINT_LIMIT : LIMIT);
    });
    try {
      return await Promise.race([(async () => {
        if (!options.print) { waiting--; await release?.(); }
        return run();
      })(), overrun]);
    } catch (error) {
      // One stuck job no longer holds up every later one: what it was
      // running is stopped and the queue moves on.
      if (error instanceof HeavyTimeout) {
        console.error(error.message);
        await Promise.allSettled(onStuck.map((fn) => fn()));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  queue = job.then(() => undefined, () => undefined);
  return job;
}
