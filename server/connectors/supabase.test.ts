// CA40/CA42 : messages Supabase (port 6543, adresse directe, superutilisateur, fonctions absentes) sur un double.
import { test } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "./supabase.ts";
import { ConnectorError, type Ctx } from "./types.ts";

const cfg = (url: string) => ({ config: { metric: "users_total" }, secrets: { url } });
const fake = (opts: { su?: boolean; missing?: boolean } = {}) => {
  const client = {
    async query(sql: string) {
      if (sql.includes("current_user")) return { rows: [{ u: "searchtide_ro.demo", d: "postgres", v: "PostgreSQL 16.2", su: !!opts.su }] };
      if (sql.includes("searchtide.")) { if (opts.missing) throw Object.assign(new Error("function does not exist"), { code: "42883" }); return { rows: [{ count: 42 }] }; }
      return { rows: [{ count: 42 }] };
    }, release() {},
  };
  return { pg: () => ({ connect: async () => client, end: async () => {} }) } as unknown as Ctx;
};

test("CA42 : port 6543 refusé", async () => {
  await assert.rejects(() => supabase.test!(cfg("postgres://searchtide_ro.demo@pooler.exemple.test:6543/postgres"), fake()),
    (e: any) => e instanceof ConnectorError && /port 5432/.test(e.message));
});

test("CA42 : adresse directe db.*.supabase.co avertie mais acceptée", async () => {
  const r = await supabase.test!(cfg("postgres://searchtide_ro.demo@db.demo.supabase.co:5432/postgres"), fake());
  assert.equal(r.ok, true);
  assert.match(r.warnings!.join(" "), /IPv6/);
  assert.match(r.label!, /demo/);
});

test("CA40 : superutilisateur refusé", async () => {
  await assert.rejects(() => supabase.test!(cfg("postgres://searchtide_ro.demo@pooler.exemple.test:5432/postgres"), fake({ su: true })),
    (e: any) => /Compte trop puissant/.test(e.message));
});

test("CA40 : fonctions absentes → message dédié", async () => {
  await assert.rejects(() => supabase.test!(cfg("postgres://searchtide_ro.demo@pooler.exemple.test:5432/postgres"), fake({ missing: true })),
    (e: any) => /fonctions Searchtide manquent/.test(e.message));
});

test("CA43 : l'indice ne contient pas le secret", () => {
  const c = cfg("postgres://searchtide_ro.demo:" + "MotDePasseSecret" + "@pooler.exemple.test:5432/postgres");
  assert.equal(supabase.hint(c), "searchtide_ro@demo");
  assert.doesNotMatch(supabase.hint(c), /MotDePasseSecret/);
});
