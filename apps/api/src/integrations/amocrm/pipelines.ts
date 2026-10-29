// Short-lived cache in front of the account's funnels.
//
// The admin screen needs pipelines and their stages on every open, and a funnel
// changes a few times a year. Caching avoids a CRM round trip per page view while
// keeping the account as the only source of truth: nothing is mirrored into our own
// tables, so a stage renamed in amoCRM cannot go stale here for longer than the TTL.

import { AmocrmClient, fetchPipelines, type Pipeline } from './client.ts';

export type PipelineCatalogueOptions = {
  accountDomain: string;
  getAccessToken: (input: { companyId: string; accountId: string }) => Promise<string>;
  fetch: typeof fetch;
  ttlMs?: number;
  now?: () => number;
};

export type PipelineCatalogue = {
  list(input: { companyId: string; accountId: string }): Promise<Pipeline[]>;
  /** Drops the cached answer; called by an explicit refresh from the admin screen. */
  invalidate(input?: { companyId: string; accountId: string }): void;
};

export function createPipelineCatalogue(options: PipelineCatalogueOptions): PipelineCatalogue {
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { readAt: number; pipelines: Pipeline[] }>();
  const keyOf = (input: { companyId: string; accountId: string }) => `${input.companyId}|${input.accountId}`;

  return {
    async list(input) {
      const key = keyOf(input);
      const cached = cache.get(key);
      const readAt = now();
      if (cached && readAt - cached.readAt < ttlMs) return cached.pipelines;
      const client = new AmocrmClient({
        accountDomain: options.accountDomain,
        getAccessToken: () => options.getAccessToken(input),
        fetch: options.fetch,
      });
      const pipelines = await fetchPipelines(client);
      cache.set(key, { readAt, pipelines });
      return pipelines;
    },

    invalidate(input) {
      if (input) cache.delete(keyOf(input));
      else cache.clear();
    },
  };
}
