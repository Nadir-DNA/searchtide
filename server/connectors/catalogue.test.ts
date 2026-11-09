// T15 : « aucune promesse non tenue » — pour chaque connecteur du catalogue qui annonce des KPI, on crée la connexion par l'API
// (fournisseur simulé par sa fixture) puis on relève CHAQUE KPI annoncé : un nombre fini doit sortir.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db.ts";
import { markAdmin } from "../admin.ts";
import { registerConnections, setConnectorContext } from "./api.ts";
import { collectVia, setCollectContext } from "./use.ts";
import { all } from "./registry.ts";
import { recordingCtx } from "./contract.ts";
import { FIXTURES } from "./fixtures.ts";
import "./index.ts";

process.env.SECRET = "t".repeat(40);
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin);
beforeEach(() => { process.env.SECRET = "t".repeat(40); db.exec("DELETE FROM connections"); });

test("chaque connecteur à KPI : connexion créée, puis chaque KPI annoncé renvoie un nombre", async () => {
  const withKpis = all().filter((c) => !c.builtin && c.kpis?.length);
  assert.ok(withKpis.length >= 5, withKpis.map((c) => c.id).join(", "));
  for (const m of withKpis) {
    const fx = FIXTURES[m.id];
    const { ctx } = recordingCtx(fx); setConnectorContext(ctx); setCollectContext(ctx);
    db.exec("DELETE FROM connections");
    const r = await admin.request("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: m.id, values: { ...fx.cfg.config, ...fx.cfg.secrets } }) });
    const created = await r.json();
    assert.equal(r.status, 201, `${m.id} : ${created.error}`);
    for (const k of m.kpis!) {
      const v = await collectVia(m.id, created.connection.id, k.id, fx.params?.[k.id] ?? {}, k.mode === "daily" ? "2026-11-09" : undefined);
      assert.ok(Number.isFinite(v), `${m.id}/${k.id} : ${v}`);
    }
  }
  setConnectorContext(undefined); setCollectContext(undefined);
});

test("les cartes sans KPI (SMTP, ntfy) n'en promettent aucun ; les intégrées ne se connectent pas", () => {
  for (const m of all()) {
    if (["smtp", "ntfy"].includes(m.id)) assert.equal(m.kpis, undefined, m.id);
    if (m.builtin) assert.equal(m.fields.length, 0, m.id);
  }
});
