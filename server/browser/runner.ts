// B3 : exécution d'une publication par le navigateur, sur une recette déclarative (page de test en B3).
// L'approbation est liée au contenu exact et rejouée avant le clic final ; sans preuve positive, « à vérifier ».
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.ts";
import { consumeApproval, verifyApproval } from "../approvals.ts";
import { mediaDir } from "../publishers/media.ts";
import { withPage } from "./pool.ts";

type Row = Record<string, any>;
export type RunResult = {
  state: "published" | "to_verify" | "action_required" | "failed";
  kind?: "approval" | "auth" | "captcha" | "denied" | "format" | "proof" | "network" | "project";
  proof?: string;
  screenshot?: string;
  message?: string;
};

/** Recette factice : localisateurs par étiquette et rôle, jamais par coordonnées. */
export const FIXTURE_RECIPE = {
  version: 1,
  entry: "/composer",
  titleLabel: "Titre",
  textLabel: "Texte",
  submitLabel: "Publier",
  proofSelector: "[data-post-url]",
  stopPaths: ["/login", "/2fa", "/captcha", "/denied"],
};

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
}): Promise<RunResult> {
  const p = o.publication;
  const projectId = projectIdOf(p.project);
  if (!projectId) return { state: "failed", kind: "project", message: "Projet de la publication introuvable" };
  const binding = publicationBinding(p);
  const approval = { agentId: o.agentId, action: "publication_publish", projectId, targetId: String(p.id), payload: binding };
  const pre = verifyApproval(o.approvalId, approval);
  if (pre !== "ok") return { state: "failed", kind: "approval", message: pre === "hash" ? "Contenu modifié depuis l'approbation" : pre === "state" ? "Approbation expirée ou déjà utilisée" : "Approbation introuvable" };

  // `web_url` est l'adresse complète ; `entry` ne sert qu'aux tests de page locale.
  const url = o.entry ? `${o.baseUrl}${o.entry}` : o.baseUrl;
  try {
    return await withPage(url, async (page) => {
      if (FIXTURE_RECIPE.stopPaths.some((s) => new URL(page.url()).pathname.startsWith(s))) {
        return { state: "action_required", kind: "auth", message: "Connexion ou vérification demandée par le site" };
      }
      try {
        await page.getByLabel(FIXTURE_RECIPE.titleLabel).fill(String(p.title ?? ""));
        await page.getByLabel(FIXTURE_RECIPE.textLabel).fill(String(p.text ?? ""));
      } catch {
        return { state: "failed", kind: "format", message: "Champ du compositeur introuvable : rien n'a été envoyé" };
      }

      // Consommation atomique juste avant le clic : une approbation ne sert qu'une fois.
      const consumed = consumeApproval(o.approvalId, approval);
      if (consumed !== "ok") return { state: "failed", kind: "approval", message: "Approbation refusée au moment de l'envoi" };

      try { await page.getByRole("button", { name: FIXTURE_RECIPE.submitLabel }).click(); }
      catch { return { state: "failed", kind: "format", message: "Bouton de publication introuvable : rien n'a été envoyé" }; }

      // Après le clic : seule une preuve positive donne « publié ».
      try {
        const el = page.locator(FIXTURE_RECIPE.proofSelector);
        await el.waitFor({ state: "attached", timeout: o.proofTimeoutMs ?? 30_000 });
        const proof = (await el.getAttribute("data-post-url")) ?? "";
        if (!proof) throw new Error("preuve vide");
        const screenshot = saveProof(String(p.id), await page.screenshot({ type: "jpeg", quality: 60 }));
        return { state: "published", proof, screenshot };
      } catch {
        let screenshot: string | undefined;
        try { screenshot = saveProof(String(p.id), await page.screenshot({ type: "jpeg", quality: 60 })); } catch { /* page perdue */ }
        return { state: "to_verify", kind: "proof", screenshot, message: "Aucune preuve positive : résultat incertain, aucune reprise automatique" };
      }
    }, { fixturePort: o.fixturePort, sandbox: o.sandbox, timeoutMs: 5 * 60_000 });
  } catch (e) {
    return { state: "to_verify", kind: "network", message: `Page perdue ou délai dépassé : ${(e as Error).message}` };
  }
}
