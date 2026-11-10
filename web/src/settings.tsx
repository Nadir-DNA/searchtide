// Réglages : surveillance, sauvegardes, notifications et sécurité de l'instance.
import { useEffect, useState } from "react";
import { api } from "./api";
import { ErrorLine, Header, KpiSkeleton, useData } from "./App";
import { Button, Card, EmptyBox, Pill, inputCls } from "./ui";

type Ops = {
  ntfy: string | null; ntfyVia: "connexion" | "env" | null; mail: boolean;
  veille: { name: string; up: boolean; since?: number; error?: string }[] | null;
  backups: { local: string[]; dir: string; offsite: { at: number; bytes: number } | null };
};
const when = (t: number) => new Date(t).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

type Weights = Record<"trend" | "goals" | "reliability" | "conversion" | "action", number>;
type Preview = { id: string; name: string; score: number | null; coverage: number; tone: "positive" | "warn" | "negative" | "none" }[];
const TONE = { positive: "text-positive", warn: "text-ink", negative: "text-negative", none: "text-muted" } as const;

/** Poids du score de santé (04-produit §5.6) : cinq nombres de 0 à 100, somme libre, aperçu des scores recalculés en direct. */
function HealthWeights() {
  const { data, reload } = useData<{ weights: Weights; defaults: Weights; labels: Record<keyof Weights, string> }>("/api/health/weights");
  const [vals, setVals] = useState<Record<string, string> | null>(null);
  const [preview, setPreview] = useState<Preview>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => { if (data && !vals) setVals(Object.fromEntries(Object.entries(data.weights).map(([k, v]) => [k, String(v)]))); }, [data, vals]);
  // Aperçu en direct : les poids saisis, non enregistrés, appliqués aux projets de l'instance
  useEffect(() => {
    if (!vals) return;
    const t = setTimeout(() => api<{ projects: Preview }>("/api/health/preview?days=28", { method: "POST", json: { weights: vals } }).then((r) => { setPreview(r.projects); setMsg((m) => (m.startsWith("Poids") ? m : "")); }).catch((e) => setMsg((e as Error).message)), 250);
    return () => clearTimeout(t);
  }, [vals]);
  if (!data || !vals) return null;
  const save = async () => {
    try { await api("/api/health/weights", { method: "PUT", json: { weights: vals } }); setMsg("Poids enregistrés."); reload(); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <Card title="Score de santé des projets">
      <p className="text-sm text-muted">Le score va de 0 à 100. Chaque composante pèse selon ces poids ; la somme n'a pas besoin de faire 100 : seuls comptent les poids des composantes réellement mesurées.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {(Object.keys(data.defaults) as (keyof Weights)[]).map((k) => (
          <label key={k} className="block text-sm">{data.labels[k]}
            <input type="number" min={0} max={100} step={1} inputMode="numeric" value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} className={`${inputCls} mt-2`} />
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="accent" onClick={save}>Enregistrer les poids</Button>
        <Button variant="secondary" onClick={() => setVals(Object.fromEntries(Object.entries(data.defaults).map(([k, v]) => [k, String(v)])))}>Rétablir les valeurs par défaut</Button>
        <span role="status" className="text-sm text-muted">{msg}</span>
      </div>
      <h3 className="mt-6 text-sm font-medium">Aperçu avec ces poids (28 jours)</h3>
      {preview.length ? (
        <ul className="mt-2 divide-y divide-rule text-sm">
          {preview.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">{p.name}</span>
              <span className={`num whitespace-nowrap ${TONE[p.tone]}`}>{p.score == null ? "—" : p.score} <span className="text-xs text-muted">· couverture {p.coverage} %</span></span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-sm text-muted">Aucun projet pour l'instant.</p>}
    </Card>
  );
}

type Job = { id: string; module: string; every: string; last_run: number | null; duration_ms: number | null; ok: number | null; error: string | null; fails: number };
const JOB_LABEL: Record<string, string> = {
  "gsc-sync": "Import Search Console", indicators: "Relevé des indicateurs", backup: "Sauvegarde locale", "offsite-backup": "Sauvegarde externe",
  alerts: "Alertes", "weekly-report": "Rapport hebdomadaire", sequences: "Séquences de relance",
};
const EVERY: Record<string, string> = { "30m": "toutes les 30 min", "3h": "toutes les 3 h", "6h": "toutes les 6 h", "daily@02:00": "chaque nuit, 2 h UTC", "daily@02:30": "chaque nuit, 2 h 30 UTC" };

/** Tâches de fond : dernière exécution et erreur de chacune (alerte dans « À traiter » après 3 échecs de suite). */
function JobsCard() {
  const { data } = useData<Job[]>("/api/jobs");
  return (
    <Card title="Tâches de fond">
      {!data?.length ? <EmptyBox>Aucune tâche pour l'instant.</EmptyBox> : (
        <ul className="divide-y divide-rule">
          {data.map((j) => (
            <li key={j.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1">{JOB_LABEL[j.id] ?? j.id}<span className="ml-2 text-xs text-muted">{EVERY[j.every] ?? j.every}</span></span>
              <span className="num text-xs text-muted">{j.last_run ? when(j.last_run) : "pas encore lancée"}</span>
              {j.ok == null ? <Pill>En attente</Pill> : j.ok ? <Pill tone="positive">OK</Pill> : <Pill tone="negative">{j.fails > 1 ? `${j.fails} échecs` : "Échec"}</Pill>}
              {!j.ok && j.error && <p className="w-full text-xs text-negative">{j.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SettingsView() {
  const { data: o, error, reload } = useData<Ops>("/api/ops");
  const { data: auth } = useData<{ totp: boolean }>("/api/auth-config");
  const [msg, setMsg] = useState<Record<string, string>>({});
  const run = async (k: string, path: string, ok: string) => {
    setMsg((m) => ({ ...m, [k]: "En cours…" }));
    try { await api(path, { method: "POST" }); setMsg((m) => ({ ...m, [k]: ok })); reload(); }
    catch (e) { setMsg((m) => ({ ...m, [k]: (e as Error).message })); }
  };
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!o) return <KpiSkeleton />;
  return (
    <>
      <Header title="Réglages" sub="Surveillance, sauvegardes, notifications et sécurité" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2"><HealthWeights /></div>
        <Card title="Surveillance" action={<span className="text-xs text-muted">Toutes les 5 min, depuis Cloudflare</span>}>
          {o.veille ? (
            <ul className="divide-y divide-rule">
              {o.veille.map((s) => (
                <li key={s.name} className="flex h-11 items-center gap-3 text-sm">
                  <span className={`size-2 rounded-full ${s.up ? "bg-positive" : "bg-negative"}`} aria-hidden />
                  <span className="flex-1">{s.name}</span>
                  {s.up ? <Pill tone="positive">En ligne</Pill> : <Pill tone="negative">Hors ligne{s.since ? ` depuis ${when(s.since)}` : ""}</Pill>}
                </li>
              ))}
            </ul>
          ) : <EmptyBox>Veille non configurée (BACKUP_URL absent de .env).</EmptyBox>}
          <p className="mt-3 text-xs text-muted">Une alerte part sur votre téléphone après 10 minutes sans réponse, puis au retour.</p>
        </Card>
        <Card title="Notifications sur le téléphone">
          {o.ntfyVia === "connexion" ? (
            <>
              <p className="text-sm">ntfy est connecté : le sujet est enregistré, chiffré, dans Connexions.</p>
              <div className="mt-4 flex items-center gap-3"><Button variant="secondary" onClick={() => run("ntfy", "/api/ops/test-notification", "Envoyée")}>Envoyer un essai</Button><span className="text-sm text-muted">{msg.ntfy}</span></div>
            </>
          ) : o.ntfy ? (
            <>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                <li>Installez l'application gratuite <b>ntfy</b> (Play Store ou App Store).</li>
                <li>Touchez « + » et abonnez-vous au sujet : <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs">{o.ntfy}</code></li>
                <li>Envoyez une notification d'essai.</li>
              </ol>
              <p className="mt-3 text-xs text-muted">Vous recevrez : site hors ligne, relevé en erreur, baisse de plus de 30 % sur une semaine, nouvelle vente, relances du jour. Gardez ce nom de sujet pour vous : il fait office de clé.</p>
              <div className="mt-4 flex items-center gap-3"><Button variant="secondary" onClick={() => run("ntfy", "/api/ops/test-notification", "Envoyée")}>Envoyer un essai</Button><span className="text-sm text-muted">{msg.ntfy}</span></div>
            </>
          ) : <EmptyBox>ntfy n'est pas connecté : ajoutez-le dans Connexions.</EmptyBox>}
        </Card>
        <Card title="Sauvegardes">
          <p className="text-sm">Chaque nuit : une copie sur le PC ({o.backups.dir}, 14 jours) et une copie compressée chez Cloudflare (30 jours).</p>
          <p className="mt-2 text-sm text-muted">Dernière copie externe : {o.backups.offsite ? `${when(o.backups.offsite.at)} · ${Math.round(o.backups.offsite.bytes / 1024)} Ko` : "aucune pour l'instant"}</p>
          <p className="mt-1 text-sm text-muted">Copies locales : {o.backups.local.length ? o.backups.local.join(", ") : "aucune pour l'instant"}</p>
          <div className="mt-4 flex items-center gap-3"><Button variant="secondary" onClick={() => run("backup", "/api/ops/backup", "Sauvegarde envoyée")}>Sauvegarder maintenant</Button><span className="text-sm text-muted">{msg.backup}</span></div>
        </Card>
        <div className="lg:col-span-2"><JobsCard /></div>
        <Card title="Sécurité">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center justify-between gap-3"><span>Double authentification</span>{auth?.totp ? <Pill tone="positive">Activée</Pill> : <Pill tone="negative">Désactivée</Pill>}</li>
            <li className="flex items-center justify-between gap-3"><span>Essais de connexion limités</span><Pill tone="positive">5 par 15 min</Pill></li>
            <li className="flex items-center justify-between gap-3"><span>Rapport et alertes par e-mail</span>{o.mail ? <Pill tone="positive">Branché</Pill> : <Pill>Non branché</Pill>}</li>
          </ul>
          {!auth?.totp && <p className="mt-3 text-xs text-muted">Pour l'activer : lancez <code className="font-mono">npm run 2fa</code> dans le dossier de Searchtide, puis scannez le QR code.</p>}
        </Card>
      </div>
    </>
  );
}
