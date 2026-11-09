// Réseau SIMULÉ de tous les connecteurs, à partir des fixtures : utilisé par les tests (unitaires et e2e). Jamais chargé en production.
import { FIXTURES } from "./fixtures.ts";
import { realCtx } from "./registry.ts";
import type { Ctx } from "./types.ts";

const provider = (url: string) =>
  url.includes("api.stripe.com") ? "stripe" : url.includes("pagespeedonline") ? "pagespeed" : /googleapis\.com|searchconsole\./.test(url) ? "google"
  : url.includes("api.exemple.test") ? "jsonapi" : url.includes("ntfy") ? "ntfy" : null;

export const simCtx = (over: Partial<Ctx> = {}): Ctx => realCtx({
  now: () => new Date("2026-11-09T10:00:00Z"),
  fetch: (async (u: any, i: RequestInit = {}) => {
    const url = String(u), f = provider(url);
    return f && FIXTURES[f]?.respond ? FIXTURES[f].respond!(url, i) : new Response("{}", { status: 404 });
  }) as typeof fetch,
  smtp: () => ({ verify: async () => true, sendMail: async () => ({}) }),
  pg: () => ({
    connect: async () => ({ query: async (sql: string) => ({ rows: FIXTURES.postgres.sql!(sql) }), release() {} }),
    end: async () => {},
  }),
  ...over,
});
