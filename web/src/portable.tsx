// Exporter / importer (format ouvert) : toutes les données dans une archive .tar.gz, réimportable ici ou ailleurs.
// L'import analyse d'abord le fichier, n'écrit rien sans confirmation, prend un instantané et peut être annulé.
import { useState } from "react";
import { api } from "./api";
import { useData } from "./App";
import { Button, Card, fmt, inputCls, useAsk } from "./ui";

type Preview = { id: string; app: string; createdAt: string; tables: Record<string, number>; current: Record<string, number>; media: { files: number; bytes: number };
  secrets: string; warnings: string[]; newer: string[] };
type Result = { mode: string; tables: Record<string, { lus: number; ecrits: number }>; media: number; snapshot: string; warnings: string[] };
const LABEL: Record<string, string> = { projects: "Projets", sites: "Sites", indicators: "Indicateurs", metrics: "Valeurs d'indicateurs", contacts: "Contacts", activities: "Échanges CRM",
  publications: "Publications", pub_accounts: "Comptes de réseaux", connections: "Connexions", events: "Visites", gsc_rows: "Données Search Console", bookings: "Rendez-vous", dashboards: "Pages", team_members: "Équipe",
  modules: "Modules", project_modules: "Modules des projets", security_events: "Journal de sécurité", settings: "Réglages", pub_media: "Médias des publications",
  milestones: "Jalons", annotations: "Notes", tracked_keywords: "Mots-clés suivis", agent_keys: "Clés d'agents", today_items: "État de « À traiter »" };
const SECRETS: Record<string, [string, string]> = {
  "aucun": ["Connexions à reconnecter après l'import (export sans phrase de passe)", "text-warn"], "phrase-requise": ["Phrase de passe nécessaire pour récupérer les connexions", "text-warn"],
  "phrase-fausse": ["Phrase de passe incorrecte", "text-negative"], "phrase-ok": ["Connexions récupérées (phrase de passe correcte)", "text-positive"],
  "coffre-ok": ["Connexions récupérées (instantané de cette instance)", "text-positive"], "coffre-autre": ["Instantané d'une autre instance : connexions à reconnecter", "text-warn"],
};
const mb = (b: number) => b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} Ko` : `${fmt(b / 1024 / 1024, 1)} Mo`;

export function PortableCard() {
  const { ask, dialog } = useAsk();
  const { data: snaps, reload: reloadSnaps } = useData<{ name: string; bytes: number }[]>("/api/import/snapshots");
  const [pass, setPass] = useState("");
  const [events, setEvents] = useState(true);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importPass, setImportPass] = useState("");
  const [mode, setMode] = useState<"remplacer" | "fusionner">("remplacer");
  const [result, setResult] = useState<Result | null>(null);
  const run = async (k: string, fn: () => Promise<void>) => { setBusy(k); setMsg(null); try { await fn(); } catch (e) { setMsg({ text: (e as Error).message, ok: false }); } setBusy(""); };

  const download = () => run("export", async () => {
    const r = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass || undefined, events }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Export impossible");
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "searchtide-export.tar.gz";
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setMsg({ text: `Export téléchargé : ${name}. Rangez-le hors de cet ordinateur (cloud, clé USB)${pass ? " et notez la phrase de passe à part" : ""}.`, ok: true });
  });
  const analyse = (file?: File) => file && run("analyse", async () => {
    setPreview(null); setResult(null);
    const r = await fetch("/api/import/preview", { method: "POST", headers: { "content-type": "application/gzip" }, body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "Fichier refusé");
    setPreview(j);
  });
  const check = () => preview && run("check", async () => setPreview(await api<Preview>(`/api/import/${preview.id}/check`, { method: "POST", json: { passphrase: importPass } })));
  const apply = () => preview && run("apply", async () => {
    const ok = await ask({ title: mode === "remplacer" ? "Remplacer toutes les données ?" : "Ajouter les données absentes ?", confirmLabel: "Importer",
      message: mode === "remplacer" ? "Les données actuelles seront remplacées par celles de l'export. Un instantané de l'état actuel est pris juste avant : vous pourrez y revenir." : "Les enregistrements déjà présents sont gardés tels quels ; seuls les absents sont ajoutés. Un instantané est pris avant." });
    if (ok === null) return;
    const r = await api<Result>(`/api/import/${preview.id}/apply`, { method: "POST", json: { mode, passphrase: importPass || undefined } });
    setResult(r); setPreview(null); reloadSnaps();
  });
  const undo = (name: string) => run("undo", async () => {
    const ok = await ask({ title: "Revenir à cet instantané ?", message: `Les données actuelles seront remplacées par l'état du ${name.replace(/^avant-import-|\.tar\.gz$/g, "").replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2}).*/, "$1 à $2 h $3")}. Un nouvel instantané est pris avant.`, confirmLabel: "Revenir" });
    if (ok === null) return;
    await api("/api/import/undo", { method: "POST", json: { name } }); reloadSnaps();
    setMsg({ text: "Données revenues à l'instantané. Rechargez la page.", ok: true });
  });
  const shown = preview ? Object.keys(preview.tables).filter((t) => preview.tables[t] || preview.current[t]).sort((a, b) => (LABEL[a] ? 0 : 1) - (LABEL[b] ? 0 : 1) || a.localeCompare(b)) : [];

  return (
    <Card title="Exporter / importer">
      {dialog}
      <p className="mb-4 text-sm text-muted">Toutes vos données dans un seul fichier, à garder hors de cet ordinateur : projets, sites, statistiques, contacts, publications et leurs médias, réglages. Format ouvert (archive .tar.gz, fichiers JSON et CSV), réimportable ici, sur une autre instance, ou lisible par un autre outil.</p>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-3 text-sm ${msg.ok ? "text-positive" : "text-negative"}`}>{msg.text}</p>}
      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="exp-t" className="space-y-3">
          <h3 id="exp-t" className="font-medium">Exporter</h3>
          <label className="block text-sm"><span className="text-muted">Phrase de passe (facultative, 10 caractères au moins)</span>
            <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} className={`${inputCls} mt-1.5`} /></label>
          <p className="text-xs text-muted">Avec une phrase de passe, les jetons de vos connexions (Stripe, Google, réseaux…) sont inclus, chiffrés : rien à reconnecter après l'import. Sans elle, ils sont retirés du fichier. Elle n'est enregistrée nulle part : notez-la.</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={events} onChange={(e) => setEvents(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />Inclure l'historique détaillé des visites (fichier plus lourd)</label>
          <Button disabled={!!busy || (!!pass && pass.length < 10)} onClick={download}>{busy === "export" ? "Préparation…" : "Télécharger l'export"}</Button>
          <p className="text-xs text-muted">Un export est aussi fait chaque semaine automatiquement dans le dossier des sauvegardes du serveur (les 4 derniers sont gardés).</p>
        </section>

        <section aria-labelledby="imp-t" className="space-y-3">
          <h3 id="imp-t" className="font-medium">Importer</h3>
          <input type="file" accept=".gz,.tgz,application/gzip" aria-label="Fichier d'export" onChange={(e) => { analyse(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} className="block text-sm" />
          <p className="text-xs text-muted">Le fichier est d'abord analysé : rien n'est modifié avant votre confirmation.</p>
          {busy === "analyse" && <p role="status" className="text-sm text-muted">Analyse du fichier…</p>}
          {preview && (
            <div className="space-y-3 rounded-xl border border-border bg-raised p-3 text-sm">
              <p>Export du <span className="font-medium">{new Date(preview.createdAt).toLocaleString("fr-FR")}</span> · Searchtide {preview.app} · {preview.media.files} média(s), {mb(preview.media.bytes)}</p>
              <div className="max-h-56 overflow-y-auto"><table className="w-full text-xs"><thead><tr className="text-left text-muted"><th className="py-1 font-medium">Données</th><th className="py-1 text-right font-medium">Dans le fichier</th><th className="py-1 text-right font-medium">Actuellement</th></tr></thead>
                <tbody>{shown.map((t) => <tr key={t} className="border-t border-rule"><td className="py-1">{LABEL[t] ?? t}</td><td className="num py-1 text-right">{fmt(preview.tables[t])}</td><td className="num py-1 text-right">{preview.current[t] == null ? "—" : fmt(preview.current[t])}</td></tr>)}</tbody></table></div>
              <p className={SECRETS[preview.secrets]?.[1]}>{SECRETS[preview.secrets]?.[0]}</p>
              {(preview.secrets === "phrase-requise" || preview.secrets === "phrase-fausse") && <div className="flex gap-2">
                <input type="password" value={importPass} onChange={(e) => setImportPass(e.target.value)} placeholder="Phrase de passe de l'export" aria-label="Phrase de passe de l'export" className={inputCls} />
                <Button type="button" variant="secondary" disabled={!importPass || !!busy} onClick={check}>Vérifier</Button></div>}
              {preview.warnings.filter((w) => !/phrase de passe|reconnect/i.test(w)).map((w) => <p key={w} className="text-negative">{w}</p>)}
              {!preview.newer.length && <>
                <fieldset className="space-y-1"><legend className="sr-only">Mode d'import</legend>
                  <label className="flex items-start gap-2"><input type="radio" name="mode" checked={mode === "remplacer"} onChange={() => setMode("remplacer")} className="mt-1" /><span><span className="font-medium">Remplacer</span> : retrouver exactement l'état de l'export (restauration, changement de serveur).</span></label>
                  <label className="flex items-start gap-2"><input type="radio" name="mode" checked={mode === "fusionner"} onChange={() => setMode("fusionner")} className="mt-1" /><span><span className="font-medium">Ajouter ce qui manque</span> : garder les données actuelles et compléter avec celles du fichier.</span></label>
                </fieldset>
                <Button disabled={!!busy} onClick={apply}>{busy === "apply" ? "Import en cours…" : "Importer"}</Button>
              </>}
            </div>
          )}
          {result && (
            <div role="status" className="rounded-xl border border-border bg-raised p-3 text-sm">
              <p className="font-medium text-positive">Import terminé ({result.mode === "remplacer" ? "remplacement" : "ajout"}) : {fmt(Object.values(result.tables).reduce((a, t) => a + t.ecrits, 0))} enregistrements, {result.media} médias.</p>
              {result.warnings.filter((w) => /reconnect/i.test(w)).map((w) => <p key={w} className="text-warn">{w}</p>)}
              <p className="mt-1 text-muted">L'état d'avant est gardé : « Revenir à cet état » ci-dessous l'annule. Rechargez la page pour voir les données importées.</p>
            </div>
          )}
          {!!snaps?.length && <div>
            <p className="label-caps mb-1">États d'avant import</p>
            <ul className="divide-y divide-rule">{snaps.slice(0, 5).map((s) => (
              <li key={s.name} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                <span className="num min-w-0 flex-1">{s.name.replace(/^avant-import-|\.tar\.gz$/g, "").replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2}).*/, "$1 à $2 h $3")}</span>
                <span className="text-xs text-muted">{mb(s.bytes)}</span>
                <a href={`/api/import/snapshots/${s.name}`} className="text-xs underline">Télécharger</a>
                <button type="button" disabled={!!busy} onClick={() => undo(s.name)} className="text-xs font-semibold text-accent hover:underline">Revenir à cet état</button>
              </li>))}</ul>
          </div>}
        </section>
      </div>
    </Card>
  );
}
