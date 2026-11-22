// The hosted app sits behind Render's proxy and Cloudflare. Now and then one
// request comes back as their error page (502, 520–524) or not at all, though
// the server is fine: the same request a moment later goes through. These are
// tried again quietly, and an error page never reaches a message as raw HTML.

/** Statuses made by the proxy in front of the server, not by the server. */
const GATEWAY = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const PAUSES = [700, 2000, 5000];

/** Saves that carry their own stamp check and retry (src/editor/sync.ts): a
 * repeat of one the server did take would be refused as stale. */
const ownRetry = (url: URL, method: string) => method === 'PUT' && /^\/api\/(booklet|defaults)$/.test(url.pathname);

export function installFetchRetry() {
  const plain = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    // Only this app's own API and files; a Request object's body can be read once.
    if (url.origin !== location.origin || request || init?.keepalive || ownRetry(url, method) || init?.signal?.aborted) return plain(input, init);
    for (let attempt = 0; ; attempt++) {
      const last = attempt === PAUSES.length || init?.signal?.aborted;
      try {
        const res = await plain(input, init);
        if (last || !GATEWAY.has(res.status)) return res;
        console.warn(`${method} ${url.pathname}: ${res.status} from the host, trying again`);
      } catch (error) {
        // Offline or the connection dropped (TypeError); an abort is final.
        if (last || (error as Error).name === 'AbortError') throw error;
        console.warn(`${method} ${url.pathname}: ${(error as Error).message}, trying again`);
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSES[attempt]));
    }
  };
}

/** A short message for a failed response: the server's own words, or for a
 * host error page only what it means. */
export async function responseError(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).trim();
  if (/^<(!doctype|html)/i.test(text) || GATEWAY.has(res.status)) {
    return `The server could not be reached just now (error ${res.status}). Please try again in a moment.`;
  }
  try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text || res.statusText || `Error ${res.status}`; }
}
