import type { QueryParams } from '../../schemas/profile.ts';
import { sleep } from '../../core/pool.ts';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 job-hunter/0.1 (personal use)';

export function buildUrl(base: string, ...parts: QueryParams[]): string {
  const url = new URL(base);
  for (const params of parts) {
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.delete(name);
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(name, v);
    }
  }
  return url.toString();
}

/**
 * Polite GET: identifies itself, enforces a minimum gap between requests to the same host,
 * times out, and retries once on network errors or 5xx/429.
 */
export class HttpClient {
  readonly #lastRequestAt = new Map<string, number>();
  readonly #minGapMs: number;

  constructor(minGapMs = 1200) {
    this.#minGapMs = minGapMs;
  }

  async getText(url: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.#throttle(new URL(url).host);
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, 'accept-language': 'uk-UA,uk;q=0.9' },
          signal: AbortSignal.timeout(30_000),
          redirect: 'follow',
        });
        if (response.ok) return await response.text();
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error;
      }
      await sleep(3000);
    }
    throw lastError;
  }

  async #throttle(host: string): Promise<void> {
    const wait = (this.#lastRequestAt.get(host) ?? 0) + this.#minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.#lastRequestAt.set(host, Date.now());
  }
}
