// J4 : médias des publications — stockage hors de web/dist, nom aléatoire, type vérifié par signature,
// plafond de taille, suppression avec la publication. Aucun accès public : lecture par l'administrateur seul.
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.ts";
import { isAdmin } from "../admin.ts";

db.exec(`CREATE TABLE IF NOT EXISTS pub_media (
  id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
)`);

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const mediaDir = () => process.env.MEDIA_DIR ?? (process.env.DATABASE_PATH?.startsWith("/data/") ? "/data/media" : "data/media");

/** Type réel par signature de fichier, jamais par extension. */
export function sniffMedia(b: Buffer): { mime: string; kind: "image" | "video" } | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", kind: "image" };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", kind: "image" };
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", kind: "image" };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii"))) return { mime: "image/gif", kind: "image" };
  if (b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = b.subarray(8, 12).toString("ascii");
    return brand === "qt  " ? { mime: "video/quicktime", kind: "video" } : { mime: "video/mp4", kind: "video" };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: "video/webm", kind: "video" };
  return null;
}

export const mediaOf = (publicationId: string) =>
  db.prepare("SELECT id, name, mime, size, created_at FROM pub_media WHERE publication_id = ? ORDER BY created_at").all(publicationId);

export function removeMedia(publicationId: string, mediaId: string) {
  const m = db.prepare("SELECT path FROM pub_media WHERE id = ? AND publication_id = ?").get(mediaId, publicationId) as { path: string } | undefined;
  if (!m) return false;
  try { rmSync(m.path, { force: true }); } catch { /* fichier déjà absent */ }
  db.prepare("DELETE FROM pub_media WHERE id = ?").run(mediaId);
  return true;
}

export function removeAllMedia(publicationId: string) {
  for (const m of db.prepare("SELECT id FROM pub_media WHERE publication_id = ?").all(publicationId) as { id: string }[]) removeMedia(publicationId, m.id);
}

export function registerMedia(app: Hono) {
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);

  app.get("/api/publications/:id/media", (c) => {
    const denied = admin(c); if (denied) return denied;
    return c.json(mediaOf(c.req.param("id")));
  });

  app.post("/api/publications/:id/media", async (c) => {
    const denied = admin(c); if (denied) return denied;
    const id = c.req.param("id");
    const pub = db.prepare("SELECT id FROM publications WHERE id = ?").get(id);
    if (!pub) return c.json({ error: "Publication introuvable" }, 404);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) return c.json({ error: `Fichier trop lourd (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} Mo maximum)` }, 413);
    const buf = Buffer.from(await c.req.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (!buf.length) return c.json({ error: "Fichier vide" }, 400);
    if (buf.length > MAX_MEDIA_BYTES) return c.json({ error: `Fichier trop lourd (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} Mo maximum)` }, 413);
    const sniffed = sniffMedia(buf);
    if (!sniffed) return c.json({ error: "Type de fichier non reconnu : JPEG, PNG, WebP, GIF, MP4, MOV ou WebM" }, 400);
    // La taille reste bornée par réseau au moment de la validation (Instagram 8 Mo pour une image).
    const dir = join(mediaDir(), id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, randomUUID());
    writeFileSync(file, buf, { mode: 0o600 });
    const mediaId = randomUUID();
    const name = String(c.req.query("name") ?? "média").slice(0, 120);
    db.prepare("INSERT INTO pub_media (id, publication_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(mediaId, id, name, sniffed.mime, buf.length, file, Date.now());
    return c.json({ id: mediaId, name, mime: sniffed.mime, size: buf.length }, 201);
  });

  app.delete("/api/publications/:id/media/:mediaId", (c) => {
    const denied = admin(c); if (denied) return denied;
    return removeMedia(c.req.param("id"), c.req.param("mediaId")) ? c.json({ ok: true }) : c.json({ error: "Média introuvable" }, 404);
  });

  app.get("/api/media/:id", (c) => {
    const denied = admin(c); if (denied) return denied;
    const m = db.prepare("SELECT path, mime FROM pub_media WHERE id = ?").get(c.req.param("id")) as { path: string; mime: string } | undefined;
    if (!m) return c.json({ error: "Média introuvable" }, 404);
    try {
      const body = readFileSync(m.path);
      c.header("content-type", m.mime);
      c.header("x-content-type-options", "nosniff");
      c.header("cache-control", "private, no-store");
      c.header("content-disposition", "inline");
      return c.body(body);
    } catch { return c.json({ error: "Média introuvable" }, 404); }
  });
}
