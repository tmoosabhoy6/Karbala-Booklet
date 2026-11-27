import { Container } from '@cloudflare/containers';

interface Env {
  BOOKLET: DurableObjectNamespace<Booklet>;
  GIT_COMMIT?: string;
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
    // A cold start pulls a large image (Chromium): wait longer than the
    // library's default 8 s + 20 s before giving up.
    await booklet.startAndWaitForPorts({
      ports: 10000,
      cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 120_000 },
    });
    return booklet.fetch(request);
  },
} satisfies ExportedHandler<Env>;
