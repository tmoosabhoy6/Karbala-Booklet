import { Container, ContainerProxy } from '@cloudflare/containers';
import { Store } from './store';

export { ContainerProxy, Store };

interface Env {
  BOOKLET: DurableObjectNamespace<Booklet>;
  STORE: DurableObjectNamespace<Store>;
  GIT_COMMIT?: string;
  /** http://store.internal: where the server keeps its files (store.ts). */
  STORE_URL?: string;
  GITHUB_STORAGE_REPO?: string;
  // Secrets (`npx wrangler secret put NAME`), all optional.
  APP_PASSWORD?: string;
  GITHUB_STORAGE_TOKEN?: string;
  OPENAI_API_KEY?: string;
}

export class Booklet extends Container<Env> {
  defaultPort = 10000;
  // Like Render's free plan, it sleeps when idle; the next visit wakes it.
  // On SIGTERM the server first finishes its storage uploads.
  sleepAfter = '15m';

  /** A container started from an older deploy is stopped (SIGTERM: the
   * server first finishes its storage uploads), so this visit starts the new
   * one, instead of waiting for it to sleep, which an open editor (it checks
   * in every minute) can put off for days. Other visits wait meanwhile. */
  async ensureCurrent(): Promise<void> {
    const current = this.env.GIT_COMMIT ?? '';
    if (!this.ctx.container?.running) {
      // Not running: the container about to start is the current deploy.
      await this.ctx.storage.put('commit', current);
      // The object before this one ("main", until 2026-11-28) may still hold
      // the one container allowed, on its old code: it is stopped once.
      if (!(await this.ctx.storage.get<boolean>('retired-main'))) {
        await this.env.BOOKLET.getByName('main').destroy().catch(() => undefined);
        await this.ctx.storage.put('retired-main', true);
      }
      return;
    }
    if ((await this.ctx.storage.get<string>('commit')) === current) return;
    // At most 25 s: a Durable Object may block for 30 s.
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put('commit', current);
      await this.stop();
      for (let i = 0; i < 25 && this.ctx.container?.running; i++) await new Promise((r) => setTimeout(r, 1000));
    });
    // This object may still run the older deploy's code: reset it, so the
    // container starts from the new code (its storage route included).
    this.ctx.abort('Restarting on the new deploy.');
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Every text variable and secret of the Worker (not its bindings) is the
    // server's environment. NODE_ENV, PORT and DATA_DIR come from the Dockerfile.
    this.envVars = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
  }
}

// The server's storage requests (STORE_URL) go to the Store Durable Object;
// nothing else of the container's traffic is touched. Assigned here, not as
// a `static` class field: a field would hide the library's setter, which is
// what registers the handler.
Booklet.outboundByHost = {
  'store.internal': (request: Request, env: unknown) => (env as Env).STORE.getByName('main').fetch(request),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // "booklet": a new name on 2026-11-28, so its code is the deployed one
    // (the old "main" object kept running old code beside its container).
    const booklet = env.BOOKLET.getByName('booklet');
    // Never in the way of a visit: at worst the old deploy answers.
    // A reset (new deploy) answers with an error: the next call reaches the new object.
    await booklet.ensureCurrent().catch((error) => console.log('ensureCurrent:', String(error)));
    const fresh = env.BOOKLET.getByName('booklet');
    // A cold start pulls a large image (Chromium): wait longer than the
    // library's default 8 s + 20 s before giving up.
    await fresh.startAndWaitForPorts({
      ports: 10000,
      cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 120_000 },
    });
    return fresh.fetch(request);
  },
} satisfies ExportedHandler<Env>;
