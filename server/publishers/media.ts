// J4 : médias des publications — stockage hors de web/dist, nom aléatoire, type vérifié par signature,
// plafond de taille, suppression avec la publication. Aucun accès public : lecture par l'administrateur seul.
import type { Hono } from "hono";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Media } from "./provider.ts";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// Lien public signé, pour les réseaux qui téléchargent eux-mêmes le média (Instagram). Valable 24 h,
// et servi seulement pendant l'envoi (publication « en cours » ou « en traitement »).
const MEDIA_LINK_TTL = 24 * 3600_000;
const sign = (id: string, exp: number) => createHmac("sha256", process.env.SECRET ?? "").update(`pub-media.${id}.${exp}`).digest("base64url").slice(0, 32);
export function signedMediaUrl(id: string, now = Date.now()) {
  const exp = now + MEDIA_LINK_TTL;
  return `${(process.env.PUBLIC_URL ?? "").replace(/\/$/, "")}/m/${id}/${exp}/${sign(id, exp)}`;
}
export const publicMediaReady = () => /^https:\/\//.test(process.env.PUBLIC_URL ?? "");

/** Médias d'une publication pour un fournisseur réel : octets lus à la demande, lien public signé. */
export function mediaFiles(publicationId: string): Media[] {
  const rows = db.prepare("SELECT id, mime, size, path FROM pub_media WHERE publication_id = ? ORDER BY created_at").all(publicationId) as { id: string; mime: string; size: number; path: string }[];
  return rows.map((m) => ({ id: m.id, mime: m.mime, size: m.size, kind: m.mime.startsWith("video/") ? "video" : "image", bytes: () => readFileSync(m.path), publicUrl: () => signedMediaUrl(m.id) }));
}

export function removeMedia(publicationId: string, mediaId: string) {
  const m = db.prepare("SELECT path FROM pub_media WHERE id = ? AND publication_id = ?").get(mediaId, publicationId) as { path: string } | undefined;
  if (!m) return false;
  try { rmSync(m.path, { force: true }); } catch { /* fichier déjà absent */ }
  db.prepare("DELETE FROM pub_media WHERE id = ?").run(mediaId);
  try { if (!readdirSync(dirname(m.path)).length) rmdirSync(dirname(m.path)); } catch { /* dossier absent ou non vide */ }   // plus de dossier vide
  return true;
}

/** Une publication en file, en cours ou publiée garde ses médias : ce qui a été approuvé est ce qui part. */
const mediaLocked = (publicationId: string) => {
  const r = db.prepare("SELECT state FROM publications WHERE id = ?").get(publicationId) as { state: string } | undefined;
  return !!r && ["scheduled", "running", "published"].includes(r.state);
};

/** Lit le corps en flux avec un plafond, sans dépendre de Content-Length : null si le plafond est dépassé. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = []; let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
  } catch { return Buffer.alloc(0); }
  return Buffer.concat(chunks);
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
    if (mediaLocked(id)) return c.json({ error: "Publication programmée ou publiée : annulez-la avant de modifier ses médias" }, 409);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) return c.json({ error: `Fichier trop lourd (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} Mo maximum)` }, 413);
    const buf = await readCapped(c.req.raw.body, MAX_MEDIA_BYTES);
    if (!buf) return c.json({ error: `Fichier trop lourd (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} Mo maximum)` }, 413);
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
    if (mediaLocked(c.req.param("id"))) return c.json({ error: "Publication programmée ou publiée : annulez-la avant de modifier ses médias" }, 409);
    return removeMedia(c.req.param("id"), c.req.param("mediaId")) ? c.json({ ok: true }) : c.json({ error: "Média introuvable" }, 404);
  });

  // Sans session : la signature, l'échéance et l'état de la publication font foi. Même réponse 404 dans tous les refus.
  app.get("/m/:id/:exp/:sig", (c) => {
    const { id, sig } = c.req.param(), exp = Number(c.req.param("exp"));
    const ok = Number.isFinite(exp) && exp > Date.now() && sig.length === 32 && timingSafeEqual(Buffer.from(sig), Buffer.from(sign(id, exp)));
    const m = ok ? db.prepare("SELECT m.path, m.mime FROM pub_media m JOIN publications p ON p.id = m.publication_id WHERE m.id = ? AND p.state IN ('running', 'processing')").get(id) as { path: string; mime: string } | undefined : undefined;
    if (!m) return c.text("Introuvable", 404);
    try {
      c.header("content-type", m.mime); c.header("x-content-type-options", "nosniff"); c.header("cache-control", "private, no-store");
      return c.body(readFileSync(m.path));
    } catch { return c.text("Introuvable", 404); }
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
