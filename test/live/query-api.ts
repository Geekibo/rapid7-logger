// A minimal client for the Rapid7 InsightOps Query API, used only by the live test to confirm
// that a posted line arrived (DESIGN §9.2). It is test infrastructure: nothing in src/ may
// import it (§3.3). The read API key is a different credential from the ingestion token.

export interface QueryApiOptions {
  readonly region: string;
  readonly logId: string;
  readonly apiKey: string;
}

export interface FoundEntry {
  readonly message: string;
  /** Rapid7's own timestamp for the entry, in ms since the epoch. */
  readonly timestamp: number;
}

interface QueryResponse {
  readonly progress?: number | null;
  readonly events?: { message: string; timestamp: number }[];
  readonly links?: { rel: string; href: string }[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function baseUrl(region: string): string {
  return region === 'us'
    ? 'https://rest.logs.insight.rapid7.com'
    : `https://${region}.rest.logs.insight.rapid7.com`;
}

export class QueryApi {
  constructor(private readonly options: QueryApiOptions) {}

  private async get(url: string): Promise<QueryResponse> {
    for (;;) {
      const response = await fetch(url, {
        headers: { 'x-api-key': this.options.apiKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429) {
        await sleep(Number(response.headers.get('retry-after')) * 1000 || 2000);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Query API ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      return (await response.json()) as QueryResponse;
    }
  }

  /** One LEQL query, followed through its continuation link until it completes. */
  async query(statement: string, fromMs: number): Promise<FoundEntry[]> {
    const params = new URLSearchParams({
      query: statement,
      from: String(fromMs),
      // A minute ahead, so a server clock slightly ahead of ours cannot hide a fresh entry.
      to: String(Date.now() + 60_000),
      per_page: '50',
    });
    let data = await this.get(
      `${baseUrl(this.options.region)}/query/logs/${this.options.logId}?${params.toString()}`,
    );
    for (let i = 0; i < 60; i++) {
      if (data.events?.length || (i > 0 && data.progress == null)) break;
      const self = data.links?.find((link) => link.rel === 'Self') ?? data.links?.[0];
      if (!self) break;
      await sleep(500);
      data = await this.get(self.href);
    }
    return (data.events ?? []).map((e) => ({ message: e.message, timestamp: e.timestamp }));
  }

  /**
   * Poll until at least one entry containing `marker` is searchable, or `timeoutMs` passes.
   * Measured 2026-10-08: an entry is stamped ~0.5 s after posting but searchable only after
   * ~10 s, so callers should allow well over that.
   */
  async find(
    marker: string,
    sentAt: number,
    timeoutMs = 60_000,
  ): Promise<{ entries: FoundEntry[]; foundAfterMs: number | null }> {
    const deadline = sentAt + timeoutMs;
    while (Date.now() < deadline) {
      const entries = await this.query(`where(/${marker}/)`, sentAt - 60_000);
      if (entries.length > 0) return { entries, foundAfterMs: Date.now() - sentAt };
      await sleep(1000);
    }
    return { entries: [], foundAfterMs: null };
  }
}
