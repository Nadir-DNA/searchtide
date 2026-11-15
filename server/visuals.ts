// Visuels et vidéos (plan D11) : un carrousel écrit en HTML aux couleurs du projet, capturé en images JPEG par le Chromium
// embarqué (aucun accès réseau pendant le rendu), puis, si ffmpeg est installé, assemblé en vidéo MP4 (diaporama).
// Les textes viennent de l'utilisateur, de son IA connectée ou d'un agent par MCP. Les fichiers se joignent à une publication.
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { chromium } from "playwright-core";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { isAdmin } from "./admin.ts";
import { LAUNCH_ARGS, chromiumExecutable, sandboxEnabled, serial } from "./browser/pool.ts";
import { mediaDir } from "./publishers/media.ts";
import { aiConnection, complete } from "./assistant.ts";

type Row = Record<string, any>;
const run = promisify(execFile);

migrate("2026-11-17-visuels", `CREATE TABLE visuals (id TEXT PRIMARY KEY, project TEXT, format TEXT NOT NULL, theme TEXT NOT NULL, slides TEXT NOT NULL,
  images TEXT NOT NULL, video TEXT, created_at INTEGER NOT NULL)`);

export const FORMATS = { carre: { w: 1080, h: 1080, label: "Carré 1:1 (Instagram, LinkedIn, Facebook)" }, portrait: { w: 1080, h: 1350, label: "Portrait 4:5 (Instagram)" }, story: { w: 1080, h: 1920, label: "Vertical 9:16 (stories, TikTok, Shorts, Reels)" } } as const;
export type Format = keyof typeof FORMATS;
export type Slide = { title: string; text?: string };
export type Theme = { color: string; mode: "clair" | "couleur"; footer: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Page HTML d'une diapositive : titre très lisible, texte court, numéro, pied (nom ou compte). Polices du système, aucun appel réseau. */
export function slideHtml(s: Slide, i: number, n: number, f: Format, t: Theme) {
  const { w, h } = FORMATS[f];
  const bg = t.mode === "couleur" ? t.color : "#fbfaf7", ink = t.mode === "couleur" ? "#ffffff" : "#16181d", accent = t.mode === "couleur" ? "#ffffff" : t.color;
  const big = s.title.length > 60 ? 64 : s.title.length > 30 ? 80 : 104;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}html,body{width:${w}px;height:${h}px;overflow:hidden}
body{background:${bg};color:${ink};font-family:"Inter","Segoe UI","Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;padding:${Math.round(w * 0.08)}px}
.n{font-size:30px;font-weight:600;letter-spacing:.08em;color:${accent};opacity:.9}.bar{width:120px;height:10px;background:${accent};border-radius:5px;margin:40px 0}
main{flex:1;display:flex;flex-direction:column;justify-content:center}h1{font-size:${big}px;line-height:1.05;font-weight:800;letter-spacing:-.02em}
p{font-size:42px;line-height:1.35;margin-top:36px;opacity:.88;white-space:pre-line}footer{display:flex;justify-content:space-between;align-items:center;font-size:30px;opacity:.8}
.dots{display:flex;gap:12px}.dots i{width:16px;height:16px;border-radius:50%;background:${ink};opacity:.25}.dots i.on{opacity:1;background:${accent}}
</style></head><body><div class="n">${String(i + 1).padStart(2, "0")} / ${String(n).padStart(2, "0")}</div><main><div class="bar"></div><h1>${esc(s.title)}</h1>${s.text ? `<p>${esc(s.text)}</p>` : ""}</main>
<footer><span>${esc(t.footer)}</span><span class="dots">${Array.from({ length: n }, (_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</span></footer></body></html>`;
}

/** Capture chaque diapositive en JPEG avec le Chromium embarqué ; toute requête réseau est bloquée. */
export async function renderSlides(slides: Slide[], f: Format, t: Theme, dir: string): Promise<string[]> {
  const { w, h } = FORMATS[f];
  return serial(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(), chromiumSandbox: sandboxEnabled(), args: [...LAUNCH_ARGS] })
      .catch((e) => { throw new Error(`Chromium indisponible pour le rendu des visuels : ${(e as Error).message.split("\n")[0]}`); });
    try {
      const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, javaScriptEnabled: false })).newPage();
      await page.route("**/*", (r) => r.abort());
      const out: string[] = [];
      for (let i = 0; i < slides.length; i++) {
        await page.setContent(slideHtml(slides[i], i, slides.length, f, t), { waitUntil: "load" });
        const file = join(dir, `diapo-${String(i + 1).padStart(2, "0")}.jpg`);
        writeFileSync(file, await page.screenshot({ type: "jpeg", quality: 90, clip: { x: 0, y: 0, width: w, height: h } }), { mode: 0o600 });
        out.push(file);
      }
      return out;
    } finally { await browser.close().catch(() => {}); }
  });
}

export const ffmpegPath = () => process.env.FFMPEG_PATH || "ffmpeg";
export async function ffmpegAvailable() { try { await run(ffmpegPath(), ["-version"], { timeout: 10_000 }); return true; } catch { return false; } }

/** Diaporama MP4 (H.264, 30 i/s) : chaque image `seconds` secondes. Compatible TikTok, Reels, Shorts. */
export async function slideshow(images: string[], f: Format, dir: string, seconds = 3) {
  const { w, h } = FORMATS[f];
  const list = join(dir, "liste.txt");
  // Le démultiplexeur concat ignore la durée de la dernière entrée : elle est répétée.
  writeFileSync(list, [...images.map((p) => `file '${p.replace(/'/g, "'\\''")}'\nduration ${seconds}`), `file '${images.at(-1)!.replace(/'/g, "'\\''")}'`].join("\n"));
  const out = join(dir, "video.mp4");
  await run(ffmpegPath(), ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `scale=${w}:${h},format=yuv420p`, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-movflags", "+faststart", out], { timeout: 180_000 });
  return out;
}

const projectColor = (project?: string | null) => project ? (db.prepare("SELECT color, name FROM projects WHERE id = ? OR crm_key = ?").get(project, project) as Row | undefined) : undefined;

export async function createVisual(input: { project?: string; format?: string; mode?: string; color?: string; footer?: string; slides?: unknown; video?: boolean; seconds?: number }) {
  const f = (input.format && input.format in FORMATS ? input.format : "carre") as Format;
  const slides = (Array.isArray(input.slides) ? input.slides : []).map((s: any) => ({ title: String(s?.title ?? "").trim().slice(0, 140), text: String(s?.text ?? "").trim().slice(0, 400) || undefined })).filter((s) => s.title).slice(0, 10);
  if (!slides.length) throw new Error("Au moins une diapositive avec un titre");
  const p = projectColor(input.project);
  const color = /^#[0-9a-f]{6}$/i.test(String(input.color ?? "")) ? String(input.color) : p?.color ?? "#ff7a52";
  const theme: Theme = { color, mode: input.mode === "couleur" ? "couleur" : "clair", footer: String(input.footer ?? p?.name ?? "").slice(0, 60) };
  const id = randomUUID(), dir = join(mediaDir(), "visuels", id);
  mkdirSync(dir, { recursive: true });
  try {
    const images = await renderSlides(slides, f, theme, dir);
    let video: string | null = null;
    if (input.video) {
      if (!(await ffmpegAvailable())) throw new Error("ffmpeg n'est pas installé sur l'instance : images créées, vidéo impossible (image Docker : WITH_BROWSER=1 l'inclut)");
      video = await slideshow(images, f, dir, Math.min(Math.max(Number(input.seconds) || 3, 1), 10));
    }
    db.prepare("INSERT INTO visuals (id, project, format, theme, slides, images, video, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.project ?? null, f, JSON.stringify(theme), JSON.stringify(slides), JSON.stringify(images), video, Date.now());
    return getVisual(id)!;
  } catch (e) {
    if (!db.prepare("SELECT 1 FROM visuals WHERE id = ?").get(id)) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
export function getVisual(id: string) {
  const r = db.prepare("SELECT * FROM visuals WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  const images = JSON.parse(r.images) as string[];
  return { id: r.id, project: r.project, format: r.format, theme: JSON.parse(r.theme), slides: JSON.parse(r.slides), images: images.length, video: !!r.video, created_at: r.created_at, _files: { images, video: r.video as string | null } };
}
const publicVisual = (v: NonNullable<ReturnType<typeof getVisual>>) => { const { _files: _f, ...rest } = v; return rest; };

/** Joint les images (ou la vidéo) à une publication encore modifiable. */
export function attachVisual(id: string, publicationId: string, what: "images" | "video") {
  const v = getVisual(id);
  if (!v) throw new Error("Visuel introuvable");
  const p = db.prepare("SELECT state FROM publications WHERE id = ?").get(publicationId) as Row | undefined;
  if (!p) throw new Error("Publication introuvable");
  if (["scheduled", "running", "processing", "published"].includes(String(p.state))) throw new Error("Publication programmée ou publiée : annulez-la avant de modifier ses médias");
  const files = what === "video" ? (v._files.video ? [v._files.video] : []) : v._files.images;
  if (!files.length) throw new Error(what === "video" ? "Ce visuel n'a pas de vidéo" : "Aucune image");
  const dir = join(mediaDir(), publicationId); mkdirSync(dir, { recursive: true });
  files.forEach((src, i) => {
    const dest = join(dir, randomUUID()); copyFileSync(src, dest);
    db.prepare("INSERT INTO pub_media (id, publication_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), publicationId, what === "video" ? "diaporama.mp4" : `diapo-${i + 1}.jpg`, what === "video" ? "video/mp4" : "image/jpeg", statSync(dest).size, dest, Date.now() + i);
  });
  return { attached: files.length };
}

/** Diapositives rédigées par l'IA connectée à partir d'un sujet (texte court, sans chiffre inventé). */
export async function slidesFromTopic(topic: string, count = 5, o: { fetch?: typeof fetch } = {}): Promise<Slide[]> {
  const conn = aiConnection();
  if (!conn) throw new Error("Aucune IA connectée : écrivez les diapositives, ou ajoutez une clé dans Connexions");
  const n = Math.min(Math.max(count, 2), 10);
  const raw = await complete(conn, "Tu écris des carrousels pour les réseaux sociaux, en français : phrases courtes, concrètes, une idée par diapositive.",
    `Sujet : ${String(topic).slice(0, 500)}\nÉcris ${n} diapositives. La première accroche, la dernière invite à agir. Titre : 60 caractères au plus. Texte : 140 caractères au plus, facultatif. Aucun chiffre ni fait inventé.\nRéponds uniquement par un tableau JSON : [{"title": "...", "text": "..."}]`, { fetch: o.fetch, maxTokens: 2000 });
  const json = /\[[\s\S]*\]/.exec(raw)?.[0];
  try { return (JSON.parse(json ?? "[]") as Slide[]).filter((s) => s && s.title).slice(0, n).map((s) => ({ title: String(s.title).slice(0, 140), text: s.text ? String(s.text).slice(0, 400) : undefined })); }
  catch { throw new Error("L'IA n'a pas renvoyé de diapositives lisibles : réessayez"); }
}

export function registerVisuals(app: Hono) {
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { const d = admin(c); if (d) return d; try { return await fn(c); } catch (e) { return c.json({ error: (e as Error).message }, 400); } };
  app.get("/api/visuals", wrap(async (c) => c.json({ formats: FORMATS, ffmpeg: await ffmpegAvailable(), ai: !!aiConnection(),
    visuals: (db.prepare("SELECT id FROM visuals ORDER BY created_at DESC LIMIT 20").all() as Row[]).map((r) => publicVisual(getVisual(r.id)!)) })));
  app.post("/api/visuals", wrap(async (c) => c.json(publicVisual(await createVisual(await c.req.json().catch(() => ({})))), 201)));
  app.post("/api/visuals/slides", wrap(async (c) => { const b = await c.req.json().catch(() => ({})); return c.json(await slidesFromTopic(String(b.topic ?? ""), Number(b.count) || 5)); }));
  app.post("/api/visuals/:id/attach", wrap(async (c) => { const b = await c.req.json().catch(() => ({})); return c.json(attachVisual(c.req.param("id"), String(b.publication_id ?? ""), b.what === "video" ? "video" : "images")); }));
  app.get("/api/visuals/:id/:file", (c) => {
    const d = admin(c); if (d) return d;
    const v = getVisual(c.req.param("id")); if (!v) return c.json({ error: "Visuel introuvable" }, 404);
    const name = c.req.param("file");
    const file = name === "video.mp4" ? v._files.video : v._files.images[Number(/^(\d+)\.jpg$/.exec(name)?.[1] ?? -1) - 1];
    if (!file || !existsSync(file)) return c.json({ error: "Fichier introuvable" }, 404);
    return c.body(readFileSync(file), 200, { "content-type": name.endsWith(".mp4") ? "video/mp4" : "image/jpeg", "cache-control": "private, max-age=3600" });
  });
  app.delete("/api/visuals/:id", wrap((c) => {
    const v = getVisual(c.req.param("id")); if (!v) return c.json({ error: "Visuel introuvable" }, 404);
    rmSync(join(mediaDir(), "visuels", v.id), { recursive: true, force: true });
    db.prepare("DELETE FROM visuals WHERE id = ?").run(v.id);
    return c.json({ ok: true });
  }));
}

/** Outil d'agent : l'agent écrit les diapositives, Searchtide les met en forme ; joindre à un brouillon de publication si demandé. */
export function registerVisualTools(server: McpServer) {
  server.registerTool("visual_generate", {
    description: "Crée un carrousel d'images (et en option une vidéo diaporama MP4) aux couleurs d'un projet, à partir de diapositives (titre, texte court). Peut le joindre à un brouillon de publication du projet.",
    inputSchema: z.object({
      project: z.string().describe("id ou clé du projet"), format: z.enum(["carre", "portrait", "story"]).default("carre"), mode: z.enum(["clair", "couleur"]).default("clair"),
      slides: z.array(z.object({ title: z.string().min(1).max(140), text: z.string().max(400).optional() })).min(1).max(10),
      video: z.boolean().default(false), publication_id: z.string().optional().describe("brouillon du même projet auquel joindre les fichiers"),
    }),
  }, async (a) => {
    if (a.publication_id) {
      const p = db.prepare("SELECT project FROM publications WHERE id = ?").get(a.publication_id) as Row | undefined;
      const keys = db.prepare("SELECT id, crm_key FROM projects WHERE id = ? OR crm_key = ?").get(a.project, a.project) as Row | undefined;
      if (!p || !keys || ![keys.id, keys.crm_key].includes(p.project)) throw new Error("Introuvable");
    }
    const v = await createVisual(a);
    const attached = a.publication_id ? attachVisual(v.id, a.publication_id, a.video ? "video" : "images") : null;
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...publicVisual(v), attached }, null, 2) }] };
  });
}
