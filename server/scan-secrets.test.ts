// S1 : le scanner ne contient aucune marque personnelle et ne s'exclut plus du contrôle.
// La liste vient d'un fichier local (hors dépôt) ; les fixtures de test sont génériques.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/scan-secrets.sh", import.meta.url).pathname;

function repoWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "st-scan-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, `${text}\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@exemple.test", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function scan(dir: string, brandsFile?: string) {
  const env = { ...process.env };
  if (brandsFile) env.BRANDS_FILE = brandsFile; else delete env.BRANDS_FILE;
  try {
    const out = execFileSync("bash", [script, dir], { env, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e: any) { return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
}

test("S1 : une marque de la liste locale est détectée, y compris dans un fichier nommé comme le scanner", () => {
  const list = mkdtempSync(join(tmpdir(), "st-brands-"));
  const brands = join(list, "brands.txt");
  writeFileSync(brands, "# commentaire\nacme-fictif\n");
  const dir = repoWith({ "src/app.ts": "const marque = 'acme-fictif';", "scripts/scan-secrets.sh": "// acme-fictif dans un faux scanner" });
  try {
    const r = scan(dir, brands);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[MOTIF\] marques de la liste locale/);
    assert.match(r.out, /src\/app\.ts/);
    assert.match(r.out, /scripts\/scan-secrets\.sh/, "aucune exclusion du chemin du scanner");
    assert.match(r.out, /marques de la liste locale dans l'historique/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(list, { recursive: true, force: true }); }
});

test("S1 : sans fichier local, le contrôle des marques est annoncé comme non configuré (jamais « aucun »)", () => {
  const dir = repoWith({ "src/app.ts": "export const ok = true;" });
  try {
    const r = scan(dir, "/nonexistent/brands.txt");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[…|\[\?\] contrôle des marques non configuré/);
    assert.doesNotMatch(r.out, /\[ok\] aucune marque/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
