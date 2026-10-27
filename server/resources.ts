// OCR/tracing and Chromium must never hold their peak allocations together
// on the 512 MB host. Both pipelines enter this same queue.
let queue = Promise.resolve();
export function heavyWork<T>(run: () => Promise<T>): Promise<T> {
  const job = queue.then(run);
  queue = job.then(() => undefined, () => undefined);
  return job;
}
