// Variantes par réseau (plan D2) : un même contenu décliné sur plusieurs comptes, un texte par compte,
// vérifié réseau par réseau avant tout envoi. Chaque compte reçoit sa propre publication (même file, mêmes états,
// même idempotence) ; elles sont reliées par un groupe pour être retrouvées ensemble.
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { migrate } from "../migrations.ts";
import { isAdmin } from "../admin.ts";
import { savePublication } from "../business.ts";
import { queuePublication, validatePublication } from "./queue.ts";

type Row = Record<string, any>;
export type BatchItem = { account_id: string; text: string; title?: string; visible?: string | null };
export type BatchInput = { title: string; day: string; items: BatchItem[]; when?: "now" | "at" | null; at?: string };

migrate("2026-11-15-publication-groupe", "ALTER TABLE publications ADD COLUMN group_id TEXT");

const accountOf = (id: string) => db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(id) as Row | undefined;

/** Ce que chaque réseau refuserait, sans rien créer : sert à l'aperçu. */
export function checkBatch(input: Pick<BatchInput, "title" | "items"> & { media?: { mime: string; size: number }[] }) {
  const media = Array.isArray(input.media) ? input.media.slice(0, 20).map((m) => ({ mime: String(m.mime), size: Number(m.size) || 0 })) : [];
  return (input.items ?? []).map((it) => {
    const account = accountOf(String(it.account_id));
    const draft = { title: it.title ?? input.title, text: it.text, network: account?.network, project: account?.project, visible: it.visible ?? null, media };
    return { account_id: it.account_id, network: account?.network ?? null, issues: validatePublication(draft, account) };
  });
}

export async function createBatch(input: BatchInput, now = Date.now()) {
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("Titre requis");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.day ?? ""))) throw new Error("Date invalide");
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new Error("Choisissez au moins un compte");
  if (items.length > 10) throw new Error("10 comptes au plus par envoi");
  if (new Set(items.map((i) => i.account_id)).size !== items.length) throw new Error("Un même compte est choisi deux fois");
  for (const it of items) if (!accountOf(String(it.account_id))) throw new Error("Compte de publication introuvable");

  const group = randomUUID();
  const results: { id: string; account_id: string; network: string; state: string; error?: string }[] = [];
  for (const it of items) {
    const account = accountOf(String(it.account_id))!;
    const p = savePublication(null, { title: it.title ?? title, day: input.day, project: account.project, network: account.network, text: it.text, account_id: account.id, visible: it.visible ?? null }) as Row;
    db.prepare("UPDATE publications SET group_id = ? WHERE id = ?").run(group, p.id);
    let state = "draft", error: string | undefined;
    if (input.when) {
      try {
        const q = await queuePublication(p.id, input.when === "now" ? { now: true } : { at: Date.parse(String(input.at)) }, now);
        state = String(q?.state ?? "scheduled");
      } catch (e) { error = (e as Error).message; }
    }
    results.push({ id: p.id, account_id: account.id, network: account.network, state, error });
  }
  return { group_id: group, items: results };
}

export function registerBatch(app: Hono) {
  app.post("/api/publications/batch/check", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    return c.json(checkBatch(await c.req.json().catch(() => ({})) as BatchInput));
  });
  app.post("/api/publications/batch", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    try { return c.json(await createBatch(await c.req.json().catch(() => ({})) as BatchInput), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
}
