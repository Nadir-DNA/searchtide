// Commun aux modules CRM et Publications : types, étapes du pipeline, mise en forme, panneau latéral et champ de formulaire.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../App";
import { Button, Card, EmptyBox, Pill, Segmented, Table, fmt, inputCls } from "../ui";

export type Contact = {
  id: string; name: string; company: string | null; email: string | null; phone: string | null; city: string | null;
  address: string | null; sector: string | null; site_url: string | null; project: string | null; source: string | null;
  stage: Stage; value: number | null; tags: string[]; next_at: string | null; next_action: string | null; opt_out: boolean;
  created_at: number; updated_at: number; activities?: { id: number; ts: number; kind: string; text: string }[];
};
export type Pub = { id: string; day: string; title: string; project: string | null; network: string | null; status: "idea" | "scheduled" | "published"; url: string | null; notes: string | null; campaign?: string | null; visits?: number;
  text?: string | null; account_id?: string | null; state?: string | null; scheduled_at?: number | null; evidence_url?: string | null; visible?: string | null; published_at?: number | null };
export const PUB_STATE: Record<string, [string, string]> = {
  draft: ["Brouillon", "text-muted"], scheduled: ["Programmée", "text-ink"], running: ["En cours", "text-ink"],
  processing: ["En traitement", "text-ink"],
  published: ["Publiée", "text-positive"], failed: ["Échec", "text-negative"], needs_action: ["Action requise", "text-negative"],
  to_verify: ["À vérifier", "text-negative"], missed: ["Manquée", "text-negative"], cancelled: ["Annulée", "text-muted"],
};
/** Libellés des tentatives (journal de la file) : jamais d'état brut affiché. */
export const ATTEMPT_LABEL: Record<string, string> = {
  scheduled: "Programmée", running: "En cours", processing: "En traitement", published: "Publiée", failed: "Échec", needs_action: "Action requise", to_verify: "À vérifier", missed: "Manquée", cancelled: "Annulée", draft: "Brouillon",
  followup: "Suite (fil ou commentaire)", refused: "Refusé par le réseau", rate: "Limite de débit", quota: "Quota atteint", network: "Erreur réseau", format: "Format invalide", unknown: "Résultat inconnu", auth: "Authentification",
};
/** Pastille du calendrier : selon l'état réel (state), avec la couleur qui va avec. */
export const PUB_CHIP: Record<string, string> = {
  published: "bg-positive-bg text-positive", scheduled: "bg-raised", running: "bg-raised", processing: "bg-raised", draft: "border border-dashed border-control text-muted",
  failed: "bg-negative-bg text-negative", needs_action: "bg-negative-bg text-negative", to_verify: "bg-negative-bg text-negative", missed: "bg-negative-bg text-negative",
  cancelled: "border border-control text-muted line-through",
};
export type Summary = {
  stages: Record<string, number>; projects: { project: string; n: number }[]; sources: { source: string; n: number }[];
  todo: number; pipelineValue: number; wonMonth: number; touchesWeek: number; pubsWeek: Pub[];
};
export type Go = (n: Record<string, string | undefined>) => void;

export const STAGES = [["new", "Nouveau"], ["contacted", "Contacté"], ["qualified", "Intéressé"], ["proposal", "Proposition"], ["won", "Gagné"], ["lost", "Perdu"]] as const;
export type Stage = (typeof STAGES)[number][0];
export const stageName = Object.fromEntries(STAGES) as Record<string, string>;
export const KINDS: Record<string, string> = { note: "Note", stage: "Étape", email: "E-mail", sms: "SMS", call: "Appel" };
export const PUB_STATUS = [["idea", "Idée"], ["scheduled", "Prévue"], ["published", "Publiée"]] as const;
export const NETWORKS = ["tiktok", "instagram", "linkedin", "youtube", "x", "facebook", "pinterest", "reddit", "gbp", "blog", "newsletter"];
/** Nom affiché et plafond de texte de chaque réseau publiable (mêmes valeurs que le serveur). */
export const NET_NAME: Record<string, string> = { x: "X", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", pinterest: "Pinterest", reddit: "Reddit", gbp: "Google Business Profile" };
export const NET_LIMIT: Record<string, number> = { x: 280, instagram: 2200, facebook: 63206, tiktok: 2200, youtube: 5000, linkedin: 3000, pinterest: 800, reddit: 40000, gbp: 1500 };
// Champs de filtre compacts (inputCls impose w-full)
export const filterCls = inputCls.replace("h-10 w-full", "h-9");
export const eur = (n: number | null | undefined) => n == null ? "—" : `${fmt(n)} €`;
export const today = () => new Date().toISOString().slice(0, 10);
export const dateFr = (d: string, o: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { ...o, timeZone: "UTC" });
/** Projet tel que rendu par /api/projects : l'identifiant est la référence, la clé CRM n'est qu'une compatibilité. */
export type ProjectRef = { id: string; name: string; crm_key: string | null; color?: string | null };
/** Un projet se désigne par son identifiant ; la clé CRM ne sert plus qu'à relire d'anciennes données. */
export const projectKey = (p: ProjectRef) => p.id;
export const keysOf = (p: ProjectRef) => [p.id, p.crm_key].filter(Boolean) as string[];

export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", f); return () => removeEventListener("keydown", f); }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
      <div role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`flex h-full w-full flex-col overflow-y-auto border-l border-border bg-ground ${wide ? "max-w-3xl" : "max-w-xl"}`}>
        <div className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-border bg-ground px-5">
          <h2 className="truncate text-lg font-light">{title}</h2>
          <button onClick={onClose} className="h-11 px-2 text-sm text-muted hover:text-ink">Fermer</button>
        </div>
        <div className="space-y-4 p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`block text-sm ${className}`}><span className="text-muted">{label}</span><div className="mt-1.5">{children}</div></label>;
}
