// OCR/tracing and Chromium must never hold their peak allocations together
// on the 512 MB host. Both pipelines enter this same queue.
let queue = Promise.resolve();
let waiting = 0;
let release: (() => Promise<void>) | null = null;
/** Called before work other than printing (it closes the warm browser). */
export const beforeOtherHeavyWork = (fn: () => Promise<void>) => { release = fn; };
/** Jobs queued and not yet started (a PDF made ahead gives way to them). */
export const heavyWaiting = () => waiting;
export function heavyWork<T>(run: () => Promise<T>, options: { print?: boolean } = {}): Promise<T> {
  if (!options.print) waiting++;
  const job = queue.then(async () => {
    if (!options.print) { waiting--; await release?.(); }
    return run();
  });
  queue = job.then(() => undefined, () => undefined);
  return job;
}
