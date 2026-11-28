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

  /** The first visit to this deploy's object stops the container of the
   * deploy before (SIGTERM: its server first finishes its storage uploads,
   * which this one brings down at its next sync), so this deploy's starts. */
  async takeOver(name: string): Promise<void> {
    if (await this.ctx.storage.get<boolean>('current')) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<boolean>('current')) return;
      const before = await this.env.STORE.getByName('main').note('container', name);
      // Objects of the deploys before this scheme: "main", then "booklet".
      const previous = before && before !== name ? [before] : before ? [] : ['main', 'booklet'];
      for (const old of previous) await this.env.BOOKLET.getByName(old).stop().catch(() => undefined);
      await this.ctx.storage.put('current', true);
    });
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
    // One object per deploy: an object keeps the code it started with while
    // its container runs (an open editor keeps it running), so a new deploy
    // gets a new object, which takes over from the one before.
    const name = `booklet-${(env.GIT_COMMIT ?? 'dev').slice(0, 12)}`;
    const booklet = env.BOOKLET.getByName(name);
    await booklet.takeOver(name).catch((error) => console.error('takeOver failed:', String(error)));
    // A cold start pulls a large image (Chromium): wait longer than the
    // library's default 8 s + 20 s before giving up.
    await booklet.startAndWaitForPorts({
      ports: 10000,
      cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 120_000 },
    });
    return booklet.fetch(request);
  },
} satisfies ExportedHandler<Env>;
