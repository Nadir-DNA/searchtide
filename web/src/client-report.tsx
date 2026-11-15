// Rapport client en marque blanche (plan A9) : votre nom, logo et couleur ; un lien secret par client, révocable.
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useData } from "./App";
import { Button, Card, copyText, inputCls } from "./ui";

type Brand = { name: string; logo: string | null; color: string; footer: string };
type Share = { token: string; days: number; label: string | null; created_at: number; expires_at: number | null; revoked_at: number | null; views: number };

export function ClientReportCard({ projectId }: { projectId: string }) {
  const { data: brand, reload: reloadBrand } = useData<Brand>("/api/report-brand");
  const { data: shares, reload } = useData<Share[]>(`/api/projects/${projectId}/report-shares`);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState("");
  const link = (t: string) => `${location.origin}/r/${t}`;
  const act = async (fn: () => Promise<unknown>, ok = "") => { setMsg(""); try { await fn(); if (ok) setMsg(ok); } catch (e) { setMsg((e as Error).message); } };
  const saveBrand = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget));
    void act(async () => { await api("/api/report-brand", { method: "PUT", json: { ...f, ...(logo !== undefined ? { logo } : {}) } }); setLogo(undefined); reloadBrand(); }, "Présentation enregistrée");
  };
  const pickLogo = (file?: File) => { if (!file) return; if (file.size > 300_000) { setMsg("Logo trop lourd : 300 Ko au plus"); return; } const r = new FileReader(); r.onload = () => setLogo(String(r.result)); r.readAsDataURL(file); };
  const share = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget));
    void act(async () => { const s = await api<Share>(`/api/projects/${projectId}/report-shares`, { method: "POST", json: { ...f, days: Number(f.days), expires_days: Number(f.expires_days) || 0 } }); await copyText(link(s.token)); reload(); }, "Lien créé et copié");
  };
  const active = (shares ?? []).filter((s) => !s.revoked_at && (!s.expires_at || s.expires_at > Date.now()));
  return (
    <Card title="Rapport client" action={<a href={`/api/projects/${projectId}/report-preview`} target="_blank" rel="noreferrer" className="text-sm font-semibold text-accent underline">Aperçu</a>}>
      <p className="mb-4 text-sm text-muted">Une page à votre nom (visites, Google, mots-clés, santé technique, réseaux, visibilité IA), partagée par un lien secret. Le client l'imprime ou l'enregistre en PDF.</p>
      {msg && <p role="status" className="mb-3 text-sm">{msg}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        {brand && <form onSubmit={saveBrand} className="space-y-3">
          <p className="label-caps">Présentation (tous les rapports)</p>
          <input name="name" defaultValue={brand.name} aria-label="Nom affiché" placeholder="Votre agence" className={inputCls} />
          <div className="flex items-center gap-3">
            <input name="color" type="color" defaultValue={brand.color} aria-label="Couleur" className="h-10 w-14 rounded border border-control bg-raised" />
            <label className="text-sm text-muted">Logo <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => pickLogo(e.currentTarget.files?.[0])} className="mt-1 block text-xs" /></label>
            {(logo ?? brand.logo) && <img src={(logo ?? brand.logo)!} alt="Logo" className="h-10 max-w-28 object-contain" />}
            {(logo ?? brand.logo) && <button type="button" onClick={() => setLogo(null)} className="text-xs text-negative">Retirer</button>}
          </div>
          <input name="footer" defaultValue={brand.footer} aria-label="Pied de page" placeholder="Pied de page (contact, site…)" className={inputCls} />
          <Button variant="secondary">Enregistrer</Button>
        </form>}
        <div>
          <p className="label-caps mb-3">Liens de partage</p>
          <form onSubmit={share} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <input name="label" placeholder="Pour qui ? (facultatif)" aria-label="Destinataire" className={inputCls} />
            <select name="days" aria-label="Période" className={`${inputCls} w-auto`}><option value="28">28 jours</option><option value="7">7 jours</option><option value="90">3 mois</option><option value="365">12 mois</option></select>
            <select name="expires_days" aria-label="Expiration" className={`${inputCls} w-auto`}><option value="0">Sans expiration</option><option value="30">30 jours</option><option value="90">90 jours</option></select>
            <Button>Créer le lien</Button>
          </form>
          <ul className="mt-3 divide-y divide-rule">{active.map((s) => (
            <li key={s.token} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{s.label ?? "Lien"} · {s.days} jours</span>
              <span className="text-xs text-muted">{s.views} vue{s.views > 1 ? "s" : ""}{s.expires_at ? ` · expire le ${new Date(s.expires_at).toLocaleDateString("fr-FR")}` : ""}</span>
              <button type="button" onClick={() => act(() => copyText(link(s.token)), "Lien copié")} className="text-xs underline">Copier</button>
              <button type="button" onClick={() => act(async () => { await api(`/api/report-shares/${s.token}`, { method: "DELETE" }); reload(); }, "Lien révoqué")} className="text-xs text-negative hover:underline">Révoquer</button>
            </li>))}</ul>
        </div>
      </div>
    </Card>
  );
}
