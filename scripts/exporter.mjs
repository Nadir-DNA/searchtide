#!/usr/bin/env node
// Export complet en ligne de commande (même format que Réglages → Exporter / importer), utilisable quand l'interface
// ne démarre plus. La base est lue sans être modifiée.
// Usage : node scripts/exporter.mjs <fichier.tar.gz>
//   EXPORT_PASSPHRASE=… pour inclure les jetons des connexions (sinon elles seront à reconnecter après import)
//   DATABASE_PATH (défaut data/searchtide.db) ; SECRET lu dans l'environnement ou dans le fichier « secret » à côté de la base
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [out] = process.argv.slice(2);
if (!out) { console.error("Usage : node scripts/exporter.mjs <fichier.tar.gz>   (EXPORT_PASSPHRASE facultatif)"); process.exit(2); }
const dbPath = process.env.DATABASE_PATH ?? "data/searchtide.db";
if (!existsSync(dbPath)) { console.error(`Base introuvable : ${dbPath} (définissez DATABASE_PATH)`); process.exit(1); }
if (!process.env.SECRET && existsSync(join(dirname(dbPath), "secret"))) process.env.SECRET = readFileSync(join(dirname(dbPath), "secret"), "utf8").trim();
const pass = process.env.EXPORT_PASSPHRASE || null;
if (pass && pass.length < 10) { console.error("EXPORT_PASSPHRASE : 10 caractères au moins"); process.exit(2); }
try {
  const { createExport } = await import("../server/portable.ts");
  const { manifest } = await createExport(resolve(out), { passphrase: pass });
  const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  console.log(`Export écrit : ${resolve(out)}`);
  console.log(`${Object.keys(manifest.tables).length} tables, ${rows} enregistrements, ${manifest.media.files} médias. Jetons des connexions : ${pass ? "inclus (protégés par la phrase de passe)" : "non inclus"}.`);
} catch (e) { console.error("Export impossible :", e.message); process.exit(1); }
