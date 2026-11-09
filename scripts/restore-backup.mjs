#!/usr/bin/env node
// Restaure une sauvegarde complète (`.bundle.json.gz`) : base + SECRET + admin-password, en droits 600.
// Usage : node scripts/restore-backup.mjs <sauvegarde.bundle.json.gz> <dossier-de-donnees>
// Aucun contenu n'est affiché ; un SECRET absent est signalé (les connexions seraient indéchiffrables).
import { readFileSync } from "node:fs";
import { decodeBundle, writeBundle } from "../server/backup-bundle.ts";

const [file, dir] = process.argv.slice(2);
if (!file || !dir) { console.error("Usage : node scripts/restore-backup.mjs <sauvegarde.bundle.json.gz> <dossier-de-donnees>"); process.exit(2); }
try {
  const b = decodeBundle(readFileSync(file));
  const { files, secretMissing } = writeBundle(dir, b);
  if (secretMissing) console.warn("ATTENTION : cette sauvegarde ne contient pas SECRET — les connexions de la base seront indéchiffrables. Restaurez une sauvegarde complète.");
  console.log(`Restauré ${files.length} fichier(s) dans ${dir} (droits 600).`);
} catch (e) {
  console.error("Restauration impossible :", e.message);
  process.exit(1);
}
