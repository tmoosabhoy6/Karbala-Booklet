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

  // The server's storage requests (STORE_URL) go to the Store Durable
  // Object; nothing else of the container's traffic is touched.
  static outboundByHost = {
    'store.internal': (request: Request, env: Env) => env.STORE.getByName('main').fetch(request),
  };

  /** A container started from an older deploy is stopped (SIGTERM: the
   * server first finishes its storage uploads), so this visit starts the new
   * one, instead of waiting for it to sleep, which an open editor (it checks
   * in every minute) can put off for days. Other visits wait meanwhile. */
  async ensureCurrent(): Promise<void> {
    const current = this.env.GIT_COMMIT ?? '';
    // Not running: the container about to start is the current deploy.
    if (!this.ctx.container?.running) return void (await this.ctx.storage.put('commit', current));
    if ((await this.ctx.storage.get<string>('commit')) === current) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put('commit', current);
      await this.stop();
      for (let i = 0; i < 60 && this.ctx.container?.running; i++) await new Promise((r) => setTimeout(r, 1000));
    });
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Every text variable and secret of the Worker (not its bindings) is the
    // server's environment. NODE_ENV, PORT and DATA_DIR come from the Dockerfile.
    this.envVars = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const booklet = env.BOOKLET.getByName('main');
    await booklet.ensureCurrent();
    // A cold start pulls a large image (Chromium): wait longer than the
    // library's default 8 s + 20 s before giving up.
    await booklet.startAndWaitForPorts({
      ports: 10000,
      cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 120_000 },
    });
    return booklet.fetch(request);
  },
} satisfies ExportedHandler<Env>;
