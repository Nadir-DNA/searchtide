#!/usr/bin/env node
// Import en ligne de commande d'un export Searchtide (.tar.gz), utilisable quand l'interface ne démarre plus.
// Vérifie l'archive, affiche ce qui va changer, prend un instantané complet de l'état actuel, puis importe dans une seule
// transaction (une erreur n'écrit rien). Arrêtez de préférence Searchtide pendant l'import, puis relancez-le.
// Usage : node scripts/importer.mjs <fichier.tar.gz> [--mode remplacer|fusionner] [--oui]
//   EXPORT_PASSPHRASE=… si l'export protège les jetons des connexions
//   La base doit exister (lancez Searchtide une fois sur une instance neuve pour la créer).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--mode");
const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "remplacer";
if (!file || !["remplacer", "fusionner"].includes(mode)) { console.error("Usage : node scripts/importer.mjs <fichier.tar.gz> [--mode remplacer|fusionner] [--oui]"); process.exit(2); }
const dbPath = process.env.DATABASE_PATH ?? "data/searchtide.db";
if (!existsSync(dbPath)) { console.error(`Base introuvable : ${dbPath}. Lancez Searchtide une fois pour la créer, puis recommencez.`); process.exit(1); }
if (!process.env.SECRET && existsSync(join(dirname(dbPath), "secret"))) process.env.SECRET = readFileSync(join(dirname(dbPath), "secret"), "utf8").trim();
try {
  const { openExport, previewExport, applyExport, safetySnapshot, portableDir } = await import("../server/portable.ts");
  const x = await openExport(resolve(file), join(portableDir(), "travail"));
  try {
    const p = previewExport(x, process.env.EXPORT_PASSPHRASE || null);
    console.log(`Export du ${p.createdAt} (Searchtide ${p.app}) — mode « ${mode} »`);
    for (const [t, n] of Object.entries(p.tables)) if (n || p.current[t]) console.log(`  ${t.padEnd(22)} ${String(n).padStart(8)} dans l'export   ${String(p.current[t] ?? "—").padStart(8)} actuellement`);
    console.log(`  médias : ${p.media.files} fichier(s)`);
    for (const w of p.warnings) console.log(`ATTENTION : ${w}`);
    if (p.newer.length) process.exit(1);
    if (!args.includes("--oui")) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ok = (await rl.question(mode === "remplacer" ? "Remplacer les données actuelles par celles de l'export ? (oui/non) " : "Ajouter les données absentes ? (oui/non) ")).trim().toLowerCase();
      rl.close();
      if (ok !== "oui") { console.log("Rien n'a été modifié."); process.exit(0); }
    }
    const snap = await safetySnapshot();
    console.log(`Instantané de l'état actuel : ${snap}`);
    const r = applyExport(x, { mode, passphrase: process.env.EXPORT_PASSPHRASE || null });
    const written = Object.values(r.tables).reduce((a, t) => a + t.ecrits, 0);
    console.log(`Import terminé : ${written} enregistrements écrits, ${r.media} médias. Relancez Searchtide.`);
    console.log(`Pour revenir en arrière : node scripts/importer.mjs "${snap}" --mode remplacer`);
  } finally { x.close(); }
} catch (e) { console.error("Import impossible (rien n'a été modifié) :", e.message); process.exit(1); }
