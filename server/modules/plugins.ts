// Modules privés : chaque fichier .ts de PLUGINS_DIR exporte par défaut un module (ou une liste), et éventuellement `connectors`.
// Les modules sont vérifiés comme les modules livrés.
// Un module refusé est écrit dans le journal sans arrêter le serveur. Le dossier n'est jamais dans le dépôt Searchtide.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkModule, registerModule } from "./registry.ts";
import type { Module } from "./types.ts";
import { register as registerConnector } from "../connectors/registry.ts";
import type { Connector } from "../connectors/types.ts";

export async function loadPlugins(dir = process.env.PLUGINS_DIR): Promise<{ loaded: string[]; rejected: { file: string; errors: string[] }[] }> {
  const out = { loaded: [] as string[], rejected: [] as { file: string; errors: string[] }[] };
  if (!dir) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    try {
      const mod = await import(pathToFileURL(join(resolve(dir), file)).href);
      for (const c of ([] as Connector[]).concat(mod.connectors ?? [])) registerConnector(c); // connecteurs privés d'abord : les modules les citent
      for (const m of ([] as Module[]).concat(mod.default ?? [])) {
        const errors = checkModule(m);
        if (errors.length) { out.rejected.push({ file, errors }); continue; }
        registerModule(m);
        out.loaded.push(m.id);
      }
    } catch (e) { out.rejected.push({ file, errors: [(e as Error).message] }); }
  }
  for (const r of out.rejected) console.error(`[modules privés] ${r.file} refusé : ${r.errors.join(", ")}`);
  if (out.loaded.length) console.log(`[modules privés] chargés : ${out.loaded.join(", ")}`);
  return out;
}
