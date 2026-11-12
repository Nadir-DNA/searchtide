#!/usr/bin/env node
// Vérifie la migration 0.3 sur une COPIE de base : chiffres, indicateurs et pages calculés avec le code de main,
// puis avec cette branche (migrations et activation des modules appliquées), et comparés.
// Usage : node scripts/verifier-migration.mjs <copie.db>   (sortie 0 = identiques, aux 0 → null près pour une source absente)
// La base donnée n'est jamais modifiée : chaque calcul travaille sur sa propre copie dans un dossier temporaire.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Une copie, jamais la base de production du conteneur (/data). */
export const isCopyPath = (p) => p.endsWith(".db") && !resolve(p).startsWith("/data/");

/** Écarts entre deux instantanés. Seul un 0 devenu null dans les totaux (source absente, spec §2) est accepté. */
export function compareSnapshots(before, after, path = "") {
  if (before === after) return [];
  if (path.startsWith("totals.") && before === 0 && after === null) return [];
  // Projet créé par la migration pour un site qui n'appartenait à aucun projet (spec §8) : nommé comme son seul site, sans indicateur
  if (/^projects\.[^.]+$/.test(path) && before === undefined && after?.indicators?.length === 0 && after.sites?.length === 1 && after.sites[0] === after.name) return [];
  const obj = (x) => x !== null && typeof x === "object";
  if (!obj(before) || !obj(after)) return [`${path} : ${JSON.stringify(before)} → ${JSON.stringify(after)}`];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.flatMap((k) => compareSnapshots(before[k], after[k], path ? `${path}.${k}` : k));
}

// Même programme dans les deux arbres : seuls les modules communs à main et à la branche sont utilisés.
const SNAPSHOT = (activate) => `
  ${activate ? `const { activateFromExistingData } = await import("./server/modules/state.ts"); activateFromExistingData();` : ""}
  const { lastDays } = await import("./server/stats.ts");
  const { listProjects } = await import("./server/projects.ts");
  const { portfolio } = await import("./server/portfolio.ts");
  const { listDashboards } = await import("./server/dashboards.ts");
  await import("./server/business.ts");
  const r = lastDays(28), t = portfolio(r).totals;
  console.log("@@" + JSON.stringify({
    totals: t,
    projects: Object.fromEntries(listProjects(r).map((p) => [p.id, { name: p.name, sites: p.sites, indicators: p.indicators.map((i) => ({ id: i.id, label: i.label, value: i.value, previous: i.previous })) }])),
    dashboards: listDashboards().map((d) => ({ name: d.name, widgets: d.widgets.map((w) => w.type) })),
  }));`;

function snapshot(tree, db, activate) {
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", SNAPSHOT(activate)],
    { cwd: tree, env: { ...process.env, DATABASE_PATH: db, PLUGINS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] }).toString();
  return JSON.parse(out.split("\n").find((l) => l.startsWith("@@")).slice(2));
}

if (process.argv[1] && basename(process.argv[1]) === "verifier-migration.mjs") {
  const src = process.argv[2];
  if (!src || !existsSync(src)) { console.error("Usage : node scripts/verifier-migration.mjs <copie.db>"); process.exit(2); }
  if (!isCopyPath(src)) { console.error("Refusé : donnez une copie (.db) de la base, jamais le fichier de production dans /data."); process.exit(2); }
  const repo = resolve(new URL("..", import.meta.url).pathname);
  const tmp = mkdtempSync(join(tmpdir(), "st-verif-"));
  const main = join(tmp, "main");
  try {
    for (const f of ["avant.db", "apres.db"]) copyFileSync(src, join(tmp, f));
    execFileSync("git", ["worktree", "add", "--detach", main, "main"], { cwd: repo, stdio: "ignore" });
    symlinkSync(join(repo, "node_modules"), join(main, "node_modules"));
    const before = snapshot(main, join(tmp, "avant.db"), false);
    const after = snapshot(repo, join(tmp, "apres.db"), true);
    const diffs = compareSnapshots(before, after);
    const projects = Object.values(before.projects);
    console.log(`${projects.length} projets, ${projects.reduce((n, p) => n + p.indicators.length, 0)} indicateurs, ${before.dashboards.length} pages comparés.`);
    if (diffs.length) { console.log(`${diffs.length} écart(s) :\n${diffs.map((d) => `  - ${d}`).join("\n")}`); process.exitCode = 1; }
    else console.log("Aucun écart : la migration garde tous les chiffres (les sources absentes passent de 0 à « — »).");
  } finally {
    try { execFileSync("git", ["worktree", "remove", "--force", main], { cwd: repo, stdio: "ignore" }); } catch { /* déjà retiré */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}
