// Export et import complets (format ouvert) : toutes les données de l'instance dans une seule archive .tar.gz lisible par
// n'importe quel outil (tar -xzf), indépendante du SECRET de l'instance :
//   manifest.json            version, date, migrations appliquées, nombre de lignes par table, empreintes des fichiers
//   tables/<table>.ndjson    une ligne JSON par enregistrement, pour toutes les tables de données
//   csv/<table>.csv          les tables lisibles par un tableur (projets, sites, contacts, publications, indicateurs…)
//   media/…                  images, vidéos et visuels des publications
// Les secrets (jetons des connexions, sessions navigateur) ne sortent que rechiffrés par une phrase de passe choisie à
// l'export ; sans phrase, ils sont retirés et les connexions sont à reconnecter après import. L'instantané pris
// automatiquement avant un import garde, lui, les secrets tels quels (« coffre ») : il ne se relit que sur la même instance.
//
// L'import vérifie tout avant de toucher à la base (archive intacte, empreintes, version compatible, phrase de passe),
// prend un instantané complet, puis écrit dans une seule transaction : en cas d'erreur, rien n'est changé.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { db } from "./db.ts";
import { open, seal } from "./vault.ts";
import { mediaDir } from "./publishers/media.ts";
import type { Hono } from "hono";
import { isAdmin } from "./admin.ts";
import { registerJob } from "./jobs.ts";
import { securityEvent } from "./security-events.ts";
import { backupPassphrase } from "./backup-settings.ts";

type Row = Record<string, any>;
export const FORMAT = "searchtide-export";
export const FORMAT_VERSION = 1;
const APP_VERSION = (() => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string; } catch { return "?"; } })();

/** Jamais exportées : schéma, compteurs de sécurité, état des tâches et des sessions, second facteur de l'instance cible. */
export const EXCLUDED = new Set(["migrations", "sqlite_sequence", "jobs", "rate_limits", "session_state", "twofa"]);
/** Tables lisibles par un tableur, en plus du NDJSON. */
const CSV_TABLES = ["projects", "sites", "indicators", "metrics", "contacts", "activities", "publications", "milestones", "annotations", "tracked_keywords", "pub_accounts", "bookings", "social_stats", "post_stats", "gbp_reviews", "briefs"];
/** Valeurs scellées par le coffre de l'instance : [table, colonne, filtre facultatif]. */
const SEALED: { table: string; column: string; where?: (r: Row) => boolean }[] = [
  { table: "connections", column: "secrets" },
  { table: "browser_sessions", column: "sealed" },
  { table: "settings", column: "value", where: (r) => r.key === "backup_passphrase" },
];
/** Colonnes qui contiennent un chemin de fichier média : réécrites vers le dossier média de l'instance d'arrivée. */
const MEDIA_PATHS: Record<string, string[]> = { pub_media: ["path"], visuals: ["images", "video"] };

export type SecretsMode = "aucun" | "phrase" | "coffre";
export type Manifest = {
  format: string; formatVersion: number; app: string; createdAt: string; migrations: string[];
  tables: Record<string, number>; mediaDir: string; media: { files: number; bytes: number };
  secrets: SecretsMode; kdf?: { salt: string; check: string }; vault?: string; files: Record<string, string>;
};

// ── Archive tar (ustar), sans dépendance ──
function tarHeader(name: string, size: number) {
  const h = Buffer.alloc(512);
  let path = name, prefix = "";
  if (Buffer.byteLength(path) > 100) { const i = path.lastIndexOf("/", 154); prefix = path.slice(0, i); path = path.slice(i + 1); }
  if (Buffer.byteLength(path) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Nom de fichier trop long pour l'archive : ${name}`);
  h.write(path, 0, "utf8");
  h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263); h.write(prefix, 345, "utf8");
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
export class TarWriter {
  fd: number; hashes: Record<string, string> = {};
  constructor(file: string) { this.fd = openSync(file, "w", 0o600); }
  add(name: string, data: Buffer | string) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    writeSync(this.fd, tarHeader(name, b.length)); writeSync(this.fd, b);
    const pad = (512 - (b.length % 512)) % 512; if (pad) writeSync(this.fd, Buffer.alloc(pad));
    this.hashes[name] = createHash("sha256").update(b).digest("hex");
  }
  /** Fichier copié par morceaux (médias volumineux). */
  addFile(name: string, src: string) {
    const size = statSync(src).size, h = createHash("sha256"), fd = openSync(src, "r"), buf = Buffer.alloc(1 << 20);
    writeSync(this.fd, tarHeader(name, size));
    try { let n: number; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) { writeSync(this.fd, buf, 0, n); h.update(buf.subarray(0, n)); } } finally { closeSync(fd); }
    const pad = (512 - (size % 512)) % 512; if (pad) writeSync(this.fd, Buffer.alloc(pad));
    this.hashes[name] = h.digest("hex");
  }
  close() { writeSync(this.fd, Buffer.alloc(1024)); closeSync(this.fd); }
}
type Entry = { name: string; offset: number; size: number };
/** Index d'une archive tar non compressée (nom → position). Refuse les chemins qui sortiraient de l'archive. */
export function tarIndex(file: string): Map<string, Entry> {
  const fd = openSync(file, "r"), h = Buffer.alloc(512), out = new Map<string, Entry>();
  try {
    let pos = 0;
    for (;;) {
      if (readSync(fd, h, 0, 512, pos) < 512 || h.every((b) => b === 0)) break;
      const str = (a: number, l: number) => h.subarray(a, a + l).toString("utf8").replace(/\0.*$/s, "");
      const name = [str(345, 155), str(0, 100)].filter(Boolean).join("/");
      const size = parseInt(str(124, 12).trim() || "0", 8);
      if (!Number.isFinite(size) || size < 0) throw new Error("Archive illisible (en-tête invalide)");
      if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Chemin refusé dans l'archive : ${name}`);
      if (str(156, 1) === "0" || str(156, 1) === "") out.set(name, { name, offset: pos + 512, size });
      pos += 512 + Math.ceil(size / 512) * 512;
    }
  } finally { closeSync(fd); }
  return out;
}
export function readEntry(file: string, e: Entry): Buffer {
  const fd = openSync(file, "r"), b = Buffer.alloc(e.size);
  try { readSync(fd, b, 0, e.size, e.offset); } finally { closeSync(fd); }
  return b;
}

// ── Chiffrement des secrets par phrase de passe (indépendant du SECRET de l'instance) ──
const kdfKey = (pass: string, salt: Buffer) => scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const encWith = (key: Buffer, text: string) => {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return ["x1", iv.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
};
const decWith = (key: Buffer, blob: string) => {
  const [v, iv, ct, tag] = String(blob).split(".");
  if (v !== "x1") throw new Error("format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url")); d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
};
const vaultFingerprint = () => createHash("sha256").update(`searchtide-vault|${process.env.SECRET ?? ""}`).digest("hex").slice(0, 16);

const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map((r) => String(r.name)).filter((t) => !EXCLUDED.has(t));
const columnsOf = (t: string) => (db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all() as Row[]).map((c) => ({ name: String(c.name), notnull: !!c.notnull, dflt: c.dflt_value, pk: Number(c.pk) }));
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const csvCell = (v: unknown) => { if (v == null) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(join(dir, d.name)) : d.isFile() ? [join(dir, d.name)] : []);
}

/** Construit l'archive. `passphrase` : secrets rechiffrés ; `vault` : secrets tels quels (instantané local). */
export async function createExport(out: string, o: { passphrase?: string | null; vault?: boolean; events?: boolean } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tar`;
  const secrets: SecretsMode = o.vault ? "coffre" : o.passphrase ? "phrase" : "aucun";
  const salt = randomBytes(16), key = secrets === "phrase" ? kdfKey(String(o.passphrase), salt) : null;
  const tw = new TarWriter(tmp);
  const counts: Record<string, number> = {};
  try {
    for (const t of tables()) {
      if (t === "events" && o.events === false) continue;
      const cols = columnsOf(t).map((c) => c.name);
      const lines: string[] = [], csv: string[] = [cols.map(csvCell).join(",")];
      for (const r of db.prepare(`SELECT * FROM ${q(t)}`).iterate() as Iterable<Row>) {
        const row: Row = { ...r };
        for (const s of SEALED) if (s.table === t && row[s.column] && (!s.where || s.where(row))) {
          if (secrets === "aucun") row[s.column] = null;
          else if (secrets === "phrase") { try { row[s.column] = encWith(key!, JSON.stringify(open(String(row[s.column])))); } catch { row[s.column] = null; } }
        }
        if (secrets === "aucun" && t === "browser_sessions") continue;   // sans secret, une session n'a pas de sens
        lines.push(JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? { $b64: Buffer.from(v).toString("base64") } : v)));
        if (CSV_TABLES.includes(t)) csv.push(cols.map((c) => csvCell(row[c])).join(","));
      }
      counts[t] = lines.length;
      tw.add(`tables/${t}.ndjson`, lines.length ? lines.join("\n") + "\n" : "");
      if (CSV_TABLES.includes(t)) tw.add(`csv/${t}.csv`, "﻿" + csv.join("\r\n") + "\r\n");
    }
    const root = mediaDir();
    const files = walk(root).filter((f) => !f.includes(`${sep}.`));
    let bytes = 0;
    for (const f of files) { tw.addFile(`media/${relative(root, f).split(sep).join("/")}`, f); bytes += statSync(f).size; }
    const manifest: Manifest = {
      format: FORMAT, formatVersion: FORMAT_VERSION, app: APP_VERSION, createdAt: new Date().toISOString(),
      migrations: (db.prepare("SELECT name FROM migrations ORDER BY name").all() as Row[]).map((r) => String(r.name)),
      tables: counts, mediaDir: root, media: { files: files.length, bytes }, secrets,
      ...(key ? { kdf: { salt: salt.toString("base64"), check: encWith(key, "searchtide") } } : {}),
      ...(secrets === "coffre" ? { vault: vaultFingerprint() } : {}),
      files: tw.hashes,
    };
    tw.add("manifest.json", JSON.stringify(manifest, null, 2));
    tw.add("LISEZMOI.txt", README);
    tw.close();
    await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(out, { mode: 0o600 }));
    return { file: out, manifest };
  } finally { rmSync(tmp, { force: true }); }
}

const README = `Export Searchtide (format ouvert)

manifest.json        version, date, nombre de lignes par table, empreintes SHA-256 de chaque fichier
tables/*.ndjson      une ligne JSON par enregistrement (toutes les tables)
csv/*.csv            tables principales, à ouvrir dans un tableur (séparateur virgule, UTF-8)
media/               images, vidéos et visuels des publications

Réimporter : Searchtide → Réglages → Exporter / importer, ou en ligne de commande :
  node scripts/importer.mjs <fichier.tar.gz> --mode remplacer
Les jetons des connexions ne sont présents que si l'export a été protégé par une phrase de passe.
`;

// ── Lecture et vérification ──
export type Opened = { dir: string; tar: string; index: Map<string, Entry>; manifest: Manifest; close(): void };
/** Décompresse l'archive dans un dossier de travail et vérifie le manifeste et les empreintes de chaque fichier. */
export async function openExport(file: string, workDir: string): Promise<Opened> {
  mkdirSync(workDir, { recursive: true });
  const tar = join(workDir, `lecture-${process.pid}-${Date.now()}.tar`);
  try { await pipeline(createReadStream(file), createGunzip(), createWriteStream(tar, { mode: 0o600 })); }
  catch { rmSync(tar, { force: true }); throw new Error("Ce fichier n'est pas un export Searchtide (archive .tar.gz illisible)"); }
  const close = () => rmSync(tar, { force: true });
  try {
    const index = tarIndex(tar);
    const m = index.get("manifest.json");
    if (!m) throw new Error("Ce fichier n'est pas un export Searchtide (manifest.json absent)");
    const manifest = JSON.parse(readEntry(tar, m).toString("utf8")) as Manifest;
    if (manifest.format !== FORMAT) throw new Error("Ce fichier n'est pas un export Searchtide");
    if (manifest.formatVersion > FORMAT_VERSION) throw new Error(`Export créé par une version plus récente de Searchtide (${manifest.app}) : mettez d'abord cette instance à jour`);
    for (const [name, hash] of Object.entries(manifest.files ?? {})) {
      const e = index.get(name);
      if (!e) throw new Error(`Archive incomplète : ${name} manque`);
      const h = createHash("sha256"), fd = openSync(tar, "r"), buf = Buffer.alloc(1 << 20);
      try { let left = e.size, pos = e.offset; while (left > 0) { const n = readSync(fd, buf, 0, Math.min(buf.length, left), pos); if (n <= 0) break; h.update(buf.subarray(0, n)); left -= n; pos += n; } } finally { closeSync(fd); }
      if (h.digest("hex") !== hash) throw new Error(`Archive abîmée : ${name} ne correspond pas à son empreinte`);
    }
    return { dir: workDir, tar, index, manifest, close };
  } catch (e) { close(); throw e; }
}

export type Preview = {
  app: string; createdAt: string; tables: Record<string, number>; media: { files: number; bytes: number };
  secrets: "aucun" | "phrase-ok" | "phrase-requise" | "phrase-fausse" | "coffre-ok" | "coffre-autre";
  newer: string[]; unknownTables: string[]; current: Record<string, number>; warnings: string[];
};

/** Ce que l'import changerait, sans rien écrire. */
export function previewExport(x: Opened, passphrase?: string | null): Preview {
  const m = x.manifest, known = new Set(tables());
  const applied = new Set((db.prepare("SELECT name FROM migrations").all() as Row[]).map((r) => String(r.name)));
  const newer = m.migrations.filter((n) => !applied.has(n));
  let secrets: Preview["secrets"] = "aucun";
  if (m.secrets === "phrase") {
    if (!passphrase) secrets = "phrase-requise";
    else { try { secrets = decWith(kdfKey(passphrase, Buffer.from(m.kdf!.salt, "base64")), m.kdf!.check) === "searchtide" ? "phrase-ok" : "phrase-fausse"; } catch { secrets = "phrase-fausse"; } }
  } else if (m.secrets === "coffre") secrets = m.vault === vaultFingerprint() ? "coffre-ok" : "coffre-autre";
  const warnings: string[] = [];
  if (newer.length) warnings.push(`Export d'une version plus récente (${m.app}) : mettez d'abord Searchtide à jour.`);
  if (secrets === "aucun") warnings.push("Export sans phrase de passe : les connexions (Stripe, Google, réseaux…) seront à reconnecter après l'import.");
  if (secrets === "phrase-requise") warnings.push("Cet export protège les jetons des connexions : indiquez sa phrase de passe pour les récupérer, sinon elles seront à reconnecter.");
  if (secrets === "phrase-fausse") warnings.push("Phrase de passe incorrecte : les connexions ne pourront pas être récupérées.");
  if (secrets === "coffre-autre") warnings.push("Instantané d'une autre instance : ses jetons sont illisibles ici, les connexions seront à reconnecter.");
  const unknownTables = Object.keys(m.tables).filter((t) => !known.has(t));
  const current = Object.fromEntries(Object.keys(m.tables).filter((t) => known.has(t)).map((t) => [t, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get() as Row).n)]));
  return { app: m.app, createdAt: m.createdAt, tables: m.tables, media: m.media, secrets, newer, unknownTables, current, warnings };
}

export type ImportMode = "remplacer" | "fusionner";
/**
 * Applique l'archive. `remplacer` : les tables de l'archive remplacent celles de l'instance ; `fusionner` : seuls les
 * enregistrements absents (même clé) sont ajoutés. Une seule transaction : une erreur annule tout.
 */
export function applyExport(x: Opened, o: { mode: ImportMode; passphrase?: string | null }) {
  const p = previewExport(x, o.passphrase);
  if (p.newer.length) throw new Error(p.warnings[0]);
  const m = x.manifest, known = new Set(tables());
  const key = p.secrets === "phrase-ok" ? kdfKey(String(o.passphrase), Buffer.from(m.kdf!.salt, "base64")) : null;
  const keepSecrets = p.secrets === "phrase-ok" || p.secrets === "coffre-ok";
  const newRoot = mediaDir(), oldRoot = m.mediaDir;
  const fixPath = (v: unknown) => typeof v === "string" && oldRoot && v.includes(oldRoot) ? v.split(oldRoot).join(newRoot) : v;
  const result: Record<string, { lus: number; ecrits: number }> = {};
  const list = Object.keys(m.tables).filter((t) => known.has(t));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("PRAGMA defer_foreign_keys = ON");
    if (o.mode === "remplacer") for (const t of list) db.exec(`DELETE FROM ${q(t)}`);
    for (const t of list) {
      const e = x.index.get(`tables/${t}.ndjson`);
      if (!e) continue;
      const cols = columnsOf(t), names = new Set(cols.map((c) => c.name));
      let read = 0, written = 0;
      const stmts = new Map<string, ReturnType<typeof db.prepare>>();
      for (const line of readEntry(x.tar, e).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        read++;
        const row = JSON.parse(line, (_k, v) => (v && typeof v === "object" && typeof v.$b64 === "string" ? Buffer.from(v.$b64, "base64") : v)) as Row;
        for (const s of SEALED) if (s.table === t && row[s.column] && (!s.where || s.where(row))) {
          if (!keepSecrets) row[s.column] = null;
          else if (key) { try { row[s.column] = seal(JSON.parse(decWith(key, String(row[s.column])))); } catch { row[s.column] = null; } }
        }
        if (t === "browser_sessions" && !row.sealed) continue;
        if (t === "settings" && row.key === "backup_passphrase" && !row.value) continue;
        // Connexion sans ses jetons : marquée à reconnecter plutôt que cassée en silence.
        if (t === "connections" && !row.secrets) { row.status = "reconnect"; row.status_detail = "Importée sans ses jetons : reconnectez-la"; }
        for (const c of MEDIA_PATHS[t] ?? []) if (c in row) row[c] = fixPath(row[c]);
        const keys = Object.keys(row).filter((k) => names.has(k));
        const missing = cols.filter((c) => c.notnull && c.dflt == null && !c.pk && !keys.includes(c.name));
        if (missing.length) throw new Error(`Table ${t} : colonne obligatoire absente de l'export (${missing.map((c) => c.name).join(", ")})`);
        const sig = keys.join(",");
        let st = stmts.get(sig);
        if (!st) { st = db.prepare(`INSERT ${o.mode === "fusionner" ? "OR IGNORE " : "OR REPLACE "}INTO ${q(t)} (${keys.map(q).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`); stmts.set(sig, st); }
        written += Number(st.run(...keys.map((k) => row[k] as any)).changes);
      }
      result[t] = { lus: read, ecrits: written };
    }
    const fk = db.prepare("PRAGMA foreign_key_check").all() as Row[];
    if (fk.length) throw new Error(`Liens incohérents dans l'export (${fk.length}, table ${fk[0].table})`);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  // Médias : écrits après la validation de la base, dans un dossier provisoire puis déplacés.
  let media = 0;
  const stage = join(dirname(newRoot), `.media-import-${Date.now()}`);
  for (const [name, e] of x.index) {
    if (!name.startsWith("media/") || e.size < 0) continue;
    const rel = name.slice("media/".length), dest = join(newRoot, ...rel.split("/"));
    if (o.mode === "fusionner" && existsSync(dest)) continue;
    const tmp = join(stage, ...rel.split("/"));
    mkdirSync(dirname(tmp), { recursive: true });
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, readEntry(x.tar, e)); } finally { closeSync(fd); }
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(tmp, dest);
    media++;
  }
  rmSync(stage, { recursive: true, force: true });
  return { mode: o.mode, tables: result, media, secrets: p.secrets, warnings: p.warnings };
}

/** Dossier des exports, instantanés et envois en attente. */
export const portableDir = () => join(process.env.BACKUP_DIR ?? (process.env.DATABASE_PATH?.startsWith("/data/") ? "/data/backups" : "data/backups"), "exports");
const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[:T]/g, "-");
/** Nom unique (millisecondes + suffixe) : deux instantanés pris dans la même seconde ne s'écrasent jamais. */
const uniqueStamp = (d = new Date()) => `${stamp(d)}-${String(d.getUTCMilliseconds()).padStart(3, "0")}-${randomBytes(3).toString("hex")}`;

/** Instantané complet avant un import (secrets du coffre conservés) : les 10 derniers sont gardés. */
export async function safetySnapshot() {
  const dir = join(portableDir(), "avant-import");
  const r = await createExport(join(dir, `avant-import-${uniqueStamp()}.tar.gz`), { vault: true });
  const all = readdirSync(dir).filter((f) => f.endsWith(".tar.gz")).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 10))) rmSync(join(dir, f), { force: true });
  return r.file;
}
export const snapshots = () => {
  const dir = join(portableDir(), "avant-import");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tar.gz")).sort().reverse().map((f) => ({ name: f, bytes: statSync(join(dir, f)).size })) : [];
};
export const snapshotPath = (name: string) => {
  if (!/^avant-import-[\da-f-]+\.tar\.gz$/.test(name)) throw new Error("Instantané inconnu");
  const f = join(portableDir(), "avant-import", name);
  if (!existsSync(f)) throw new Error("Instantané introuvable");
  return f;
};

/** Export hebdomadaire automatique, gardé dans le dossier des sauvegardes (4 derniers) ; secrets protégés par la phrase de sauvegarde si elle existe. */
export async function weeklyExport(passphrase: string | null) {
  const dir = join(portableDir(), "hebdo");
  const r = await createExport(join(dir, `searchtide-export-${stamp()}.tar.gz`), { passphrase });
  const all = readdirSync(dir).filter((f) => f.endsWith(".tar.gz")).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 4))) rmSync(join(dir, f), { force: true });
  return r.file;
}
export { stamp };

// ── Routes : réservées à l'administrateur (propriétaire ou membre « admin ») ──

const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;
const pending = new Map<string, { file: string; at: number }>();
function sweep() { for (const [id, p] of pending) if (Date.now() - p.at > 3_600_000) { rmSync(p.file, { force: true }); pending.delete(id); } }

/** Corps de requête écrit sur disque par morceaux, borné. */
async function saveBody(body: ReadableStream<Uint8Array> | null, file: string) {
  if (!body) throw new Error("Fichier vide");
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "w", 0o600); let size = 0;
  try {
    const reader = body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_UPLOAD) throw new Error("Fichier trop lourd (4 Go au plus)"); writeSync(fd, value); }
  } catch (e) { closeSync(fd); rmSync(file, { force: true }); throw e; }
  closeSync(fd);
  if (!size) { rmSync(file, { force: true }); throw new Error("Fichier vide"); }
  return size;
}
let busy = false;
const exclusive = async <T>(fn: () => Promise<T>) => { if (busy) throw new Error("Un export ou un import est déjà en cours"); busy = true; try { return await fn(); } finally { busy = false; } };

export function registerPortable(app: Hono) {
  registerJob("projets", { id: "export-hebdo", every: "168h", run: async () => { await weeklyExport(backupPassphrase()); } });
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  const work = () => join(portableDir(), "travail");

  app.post("/api/export", async (c) => {
    const d = admin(c); if (d) return d;
    const b = await c.req.json().catch(() => ({})) as Row;
    const pass = typeof b.passphrase === "string" && b.passphrase ? b.passphrase : null;
    if (pass && pass.length < 10) return c.json({ error: "Phrase de passe de 10 caractères au moins" }, 400);
    try {
      const file = join(work(), `searchtide-export-${stamp()}.tar.gz`);
      await exclusive(() => createExport(file, { passphrase: pass, events: b.events !== false }));
      const data = readFileSync(file); rmSync(file, { force: true });
      securityEvent("data_exported", pass ? "export complet, secrets protégés" : "export complet, sans secrets");
      return c.body(data, 200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="${file.split(sep).pop()}"`, "cache-control": "no-store" });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  // Étape 1 : envoi et analyse, rien n'est écrit dans la base.
  app.post("/api/import/preview", async (c) => {
    const d = admin(c); if (d) return d;
    sweep();
    const id = randomBytes(12).toString("hex"), file = join(work(), `envoi-${id}.tar.gz`);
    try {
      await saveBody(c.req.raw.body, file);
      const x = await openExport(file, work());
      try {
        pending.set(id, { file, at: Date.now() });
        return c.json({ id, ...previewExport(x, c.req.header("x-passphrase") ? decodeURIComponent(c.req.header("x-passphrase")!) : null) });
      } finally { x.close(); }
    } catch (e) { rmSync(file, { force: true }); return c.json({ error: (e as Error).message }, 400); }
  });
  app.post("/api/import/:id/check", async (c) => {
    const d = admin(c); if (d) return d;
    const p = pending.get(c.req.param("id")); if (!p) return c.json({ error: "Envoi expiré : renvoyez le fichier" }, 404);
    const b = await c.req.json().catch(() => ({})) as Row;
    const x = await openExport(p.file, work());
    try { return c.json({ id: c.req.param("id"), ...previewExport(x, b.passphrase ?? null) }); } finally { x.close(); }
  });
  // Étape 2 : instantané automatique, puis import dans une transaction.
  app.post("/api/import/:id/apply", async (c) => {
    const d = admin(c); if (d) return d;
    if (process.env.DEMO === "1") return c.json({ error: "Désactivé en démonstration." }, 403);
    const p = pending.get(c.req.param("id")); if (!p) return c.json({ error: "Envoi expiré : renvoyez le fichier" }, 404);
    const b = await c.req.json().catch(() => ({})) as Row;
    const mode: ImportMode = b.mode === "fusionner" ? "fusionner" : "remplacer";
    try {
      const r = await exclusive(async () => {
        const snapshot = await safetySnapshot();
        const x = await openExport(p.file, work());
        try { return { ...applyExport(x, { mode, passphrase: b.passphrase ?? null }), snapshot: snapshot.split(sep).pop() }; } finally { x.close(); }
      });
      rmSync(p.file, { force: true }); pending.delete(c.req.param("id"));
      securityEvent("data_imported", `import (${mode})`);
      return c.json(r);
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/import/snapshots", (c) => admin(c) ?? c.json(snapshots()));
  app.get("/api/import/snapshots/:name", (c) => {
    const d = admin(c); if (d) return d;
    try { const f = snapshotPath(c.req.param("name")); return c.body(readFileSync(f), 200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="${c.req.param("name")}"`, "cache-control": "no-store" }); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });
  // Retour arrière : l'instantané remplace les données actuelles (lui-même précédé d'un nouvel instantané).
  app.post("/api/import/undo", async (c) => {
    const d = admin(c); if (d) return d;
    const b = await c.req.json().catch(() => ({})) as Row;
    try {
      const f = snapshotPath(String(b.name ?? ""));
      const r = await exclusive(async () => {
        const snapshot = await safetySnapshot();
        const x = await openExport(f, work());
        try { return { ...applyExport(x, { mode: "remplacer" }), snapshot: snapshot.split(sep).pop() }; } finally { x.close(); }
      });
      securityEvent("data_imported", "retour à un instantané d'avant import");
      return c.json(r);
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
}
