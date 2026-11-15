// B3 : exécution d'une publication par le navigateur, sur une recette déclarative (page de test en B3).
// L'approbation est liée au contenu exact et rejouée avant le clic final ; sans preuve positive, « à vérifier ».
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.ts";
import { consumeApproval, verifyApproval } from "../approvals.ts";
import { mediaDir } from "../publishers/media.ts";
import { withPage } from "./pool.ts";
import { FIXTURE_RECIPE, type Recipe, type Target } from "./recipes.ts";
import type { Locator, Page } from "playwright-core";

type Row = Record<string, any>;
export type RunResult = {
  state: "published" | "to_verify" | "action_required" | "failed";
  kind?: "approval" | "auth" | "captcha" | "denied" | "format" | "proof" | "network" | "project";
  proof?: string;
  screenshot?: string;
  message?: string;
};

export { FIXTURE_RECIPE } from "./recipes.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Contenu exact soumis à l'approbation : compte, réseau, projet, texte, médias, visibilité, date. */
export function publicationBinding(p: Row): Row {
  const media = (db.prepare("SELECT path FROM pub_media WHERE publication_id = ? ORDER BY created_at").all(p.id) as { path: string }[])
    .map((m) => { try { return sha(readFileSync(m.path)); } catch { return "absent"; } });
  return {
    account_id: p.account_id ?? null,
    network: p.network ?? null,
    project: p.project ?? null,
    text: p.text ?? "",
    visible: p.visible ?? null,
    date: Number(p.scheduled_at ?? 0),
    media,
  };
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return (db.prepare("SELECT id FROM projects WHERE id = ? OR crm_key = ?").get(value, value) as { id: string } | undefined)?.id ?? null;
}

function saveProof(pubId: string, jpeg: Buffer): string {
  const dir = join(mediaDir(), "proofs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pubId}.jpg`);
  writeFileSync(file, jpeg, { mode: 0o600 });
  return file;
}

/**
 * Publie avec le navigateur. `approvalId` est vérifié avant tout lancement, puis consommé juste avant
 * le clic final. Toute ambiguïté après le clic donne « à vérifier », jamais de nouvelle tentative ici.
 */
export async function publishWithBrowser(o: {
  publication: Row;
  account: Row;
  approvalId: string;
  agentId: string;
  baseUrl: string;
  fixturePort: number;
  sandbox?: boolean;
  entry?: string;
  proofTimeoutMs?: number;
  recipe?: Recipe;
  storageState?: Record<string, unknown> | null;
  mediaPaths?: string[];
}): Promise<RunResult> {
  const recipe = o.recipe ?? FIXTURE_RECIPE;
  const p = o.publication;
  const projectId = projectIdOf(p.project);
  if (!projectId) return { state: "failed", kind: "project", message: "Projet de la publication introuvable" };
  const binding = publicationBinding(p);
  const approval = { agentId: o.agentId, action: "publication_publish", projectId, targetId: String(p.id), payload: binding };
  const pre = verifyApproval(o.approvalId, approval);
  if (pre !== "ok") return { state: "failed", kind: "approval", message: pre === "hash" ? "Contenu modifié depuis l'approbation" : pre === "state" ? "Approbation expirée ou déjà utilisée" : "Approbation introuvable" };

  // `web_url` est l'adresse complète ; `entry` ne sert qu'aux tests de page locale ; sinon l'adresse de départ de la recette.
  const url = o.entry ? `${o.baseUrl}${o.entry}` : o.baseUrl || recipe.entry;
  const media = o.mediaPaths ?? [];
  if (media.length && !recipe.upload) return { state: "failed", kind: "format", message: `Médias non pris en charge par la publication navigateur sur ${recipe.network} : rien n'a été envoyé` };
  try {
    return await withPage(url, async (page) => {
      const stopped = () => recipe.stopPaths.some((s) => new URL(page.url()).pathname.startsWith(s));
      if (stopped()) return { state: "action_required", kind: "auth", message: "Connexion ou vérification demandée par le site : reconnectez la session dans « Connexions navigateur »" };
      try {
        for (const step of recipe.open ?? []) await (await find(page, step)).click();
        if (recipe.title) await (await find(page, recipe.title)).fill(String(p.title ?? ""));
        await (await find(page, recipe.text)).fill(String(p.text ?? ""));
        if (media.length) await (await find(page, recipe.upload!, "attached")).setInputFiles(media);
      } catch {
        return stopped() ? { state: "action_required", kind: "auth", message: "Connexion demandée par le site" }
          : { state: "failed", kind: "format", message: `Compositeur introuvable sur ${recipe.network} (recette ${recipe.version}${recipe.validated ? "" : ", non éprouvée"}) : rien n'a été envoyé` };
      }

      // Consommation atomique juste avant le clic : une approbation ne sert qu'une fois.
      const consumed = consumeApproval(o.approvalId, approval);
      if (consumed !== "ok") return { state: "failed", kind: "approval", message: "Approbation refusée au moment de l'envoi" };

      let submit: Locator;
      try { submit = await find(page, recipe.submit); }
      catch { return { state: "failed", kind: "format", message: "Bouton de publication introuvable : rien n'a été envoyé" }; }
      await submit.click();

      // Après le clic : seule une preuve positive donne « publié ».
      const shot = async () => { try { return saveProof(String(p.id), await page.screenshot({ type: "jpeg", quality: 60 })); } catch { return undefined; } };
      if (recipe.proof) {
        try {
          const el = page.locator(recipe.proof.css).first();
          await el.waitFor({ state: "attached", timeout: o.proofTimeoutMs ?? 30_000 });
          const raw = (await el.getAttribute(recipe.proof.attr)) ?? "";
          const proof = raw ? new URL(raw, page.url()).toString() : "";
          if (!proof || (recipe.proof.mustInclude && !proof.includes(recipe.proof.mustInclude))) throw new Error("preuve vide");
          return { state: "published", proof, screenshot: await shot() };
        } catch { /* pas de preuve : à vérifier ci-dessous */ }
      } else if (recipe.confirm) {
        try {
          await (await find(page, recipe.confirm, "visible", o.proofTimeoutMs ?? 20_000)).waitFor({ state: "visible", timeout: 1000 });
          return { state: "to_verify", kind: "proof", screenshot: await shot(), message: `${recipe.network} a affiché sa confirmation sans donner l'adresse : collez le lien du post pour la marquer publiée` };
        } catch { /* rien de visible */ }
      }
      return { state: "to_verify", kind: "proof", screenshot: await shot(), message: "Aucune preuve positive : résultat incertain, aucune reprise automatique" };
    }, { fixturePort: o.fixturePort, sandbox: o.sandbox, timeoutMs: 5 * 60_000, storageState: o.storageState });
  } catch (e) {
    return { state: "to_verify", kind: "network", message: `Page perdue ou délai dépassé : ${(e as Error).message}` };
  }
}

/** Première alternative présente dans la page ; échoue si aucune n'apparaît dans le délai. */
async function find(page: Page, targets: Target[], state: "visible" | "attached" = "visible", timeout = 15_000): Promise<Locator> {
  const loc = (t: Target): Locator => t.css ? page.locator(t.css)
    : t.label ? page.getByLabel(t.label)
    : page.getByRole(t.role ?? "button", t.name ? { name: new RegExp(t.name, "i") } : {});
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const t of targets) {
      const l = loc(t).first();
      if (await l.count().catch(() => 0)) {
        if (state === "attached" || await l.isVisible().catch(() => false)) return l;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error("cible introuvable");
}
