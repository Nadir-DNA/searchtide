// Réglages : surveillance, sauvegardes, notifications et sécurité de l'instance.
import { useEffect, useState } from "react";
import { api } from "./api";
import { ErrorLine, Header, KpiSkeleton, useData } from "./App";
import { Button, Card, EmptyBox, Pill, inputCls, Status } from "./ui";

type Ops = {
  ntfy: string | null; ntfyVia: "connexion" | "env" | null; mail: boolean;
  veille: { name: string; up: boolean; since?: number; error?: string }[] | null;
  version: string; migration: number | null; tz: string; docker: boolean; offsiteConfigured: boolean;
  backups: { local: string[]; dir: string; offsite: { at: number; bytes: number } | null; verified: { at: number; ok: boolean; detail: string } | null; passphrase: boolean; passSource: "env" | "settings" | null; passFingerprint: string | null };
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
          <label key={k} className="block min-w-0 text-sm">{data.labels[k]}
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

type Diag = {
  version: string; now: number; tz: string; docker: boolean;
  disk: { free: number; total: number } | null;
  jobs: { id: string; ok: number | null; fails: number; last_run: number | null; error: string | null }[];
};
type Outbound = { url: string; ok: boolean; status?: number; ms: number; error?: string }[];

/** A8 : diagnostic de l'instance et test d'accès sortant (déclenché par l'utilisateur, aucune donnée envoyée). */
function DiagnosticCard() {
  const { data } = useData<Diag>("/api/diagnostic");
  const [out, setOut] = useState<Outbound | null>(null);
  const [busy, setBusy] = useState(false);
  async function test() {
    setBusy(true); setOut(null);
    try { setOut((await api<{ results: Outbound }>("/api/diagnostic/outbound", { method: "POST" })).results); }
    catch (e) { setOut([{ url: "—", ok: false, ms: 0, error: (e as Error).message }]); }
    setBusy(false);
  }
  if (!data) return null;
  const free = data.disk ? `${Math.round(data.disk.free / 1024 ** 3 * 10) / 10} Go libres sur ${Math.round(data.disk.total / 1024 ** 3 * 10) / 10} Go` : "volume illisible";
  const failing = data.jobs.filter((j) => j.ok === 0 || j.fails > 0);
  return (
    <Card title="Diagnostic">
      <ul className="space-y-2 text-sm">
        <li className="flex justify-between gap-3"><span>Version</span><span className="num">{data.version}</span></li>
        <li className="flex justify-between gap-3"><span>Heure du serveur</span><span className="num">{when(data.now)}</span></li>
        <li className="flex justify-between gap-3"><span>Fuseau des journées</span><code className="font-mono text-xs">{data.tz}</code></li>
        <li className="flex justify-between gap-3"><span>Espace disque</span><span className="num">{free}</span></li>
        <li className="flex justify-between gap-3"><span>Tâches en échec</span><span>{failing.length ? failing.map((j) => j.id).join(", ") : "aucune"}</span></li>
      </ul>
      {!data.docker && <p className="mt-2 text-xs text-muted">Instance hors Docker : la sauvegarde locale reste dans le dossier de l'application.</p>}
      <div className="mt-3"><Button variant="secondary" onClick={test} disabled={busy}>{busy ? "Test en cours…" : "Tester l'accès sortant"}</Button></div>
      {out && <ul className="mt-2 space-y-1 text-xs">{out.map((r) => <li key={r.url}>{r.ok ? "✓" : "✗"} {r.url} · {r.ms} ms{r.status ? ` · ${r.status}` : ""}{r.error ? ` · ${r.error}` : ""}</li>)}</ul>}
      <p className="mt-2 text-xs text-muted">Le test contacte deux hôtes fixes, sans envoyer de données, et s'arrête après 5 s.</p>
    </Card>
  );
}

type TwoFa = { enabled: boolean; source: "env" | "settings" | null; codesLeft: number };

/** 1.4 : activation/désactivation de la double authentification, réservée à la session administrateur. */
function TwoFactor({ onChanged }: { onChanged: () => void }) {
  const { data, reload } = useData<TwoFa>("/api/2fa");
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function begin() {
    setMsg(""); setBusy(true);
    try { setSetup(await api<{ secret: string; qr: string }>("/api/2fa/setup", { method: "POST" })); }
    catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }
  async function activateNow() {
    setBusy(true); setMsg("");
    try {
      const r = await api<{ codes: string[] }>("/api/2fa/activate", { method: "POST", json: { code } });
      setCodes(r.codes); setSetup(null); setCode(""); reload(); onChanged();
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }
  async function disableNow() {
    setBusy(true); setMsg("");
    try {
      await api("/api/2fa/disable", { method: "POST", json: { password, code: disableCode } });
      setPassword(""); setDisableCode(""); reload(); onChanged();
      setMsg("Double authentification désactivée.");
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }
  if (!data) return null;
  return (
    <div className="text-sm">
      <div className="flex items-center justify-between gap-3"><span>Double authentification</span>
        {data.enabled ? <Pill tone="positive">Activée{data.source === "env" ? " (TOTP_SECRET)" : ""}</Pill> : <Pill tone="negative">Désactivée</Pill>}
      </div>
      {data.enabled && data.source === "settings" && <p className="mt-2 text-xs text-muted">{data.codesLeft} code(s) de secours restant(s).</p>}
      {!data.enabled && !setup && (
        <div className="mt-3">
          <Button variant="secondary" onClick={begin} disabled={busy}>{busy ? "Préparation…" : "Configurer"}</Button>
          <p className="mt-2 text-xs text-muted">Facultative et désactivée par défaut. Recommandée si l'instance est exposée à Internet.</p>
        </div>
      )}
      {setup && (
        <div className="mt-3 space-y-2 rounded-xl border border-border p-3">
          <p className="text-xs text-muted">Scannez ce QR code avec une application d'authentification, puis saisissez le code affiché.</p>
          <div className="w-[180px] max-w-full" dangerouslySetInnerHTML={{ __html: setup.qr }} />
          <p className="break-all font-mono text-xs">Clé à saisir à la main : {setup.secret}</p>
          <label className="block text-xs text-muted">Code à 6 chiffres
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" className={`${inputCls} mt-1`} />
          </label>
          <Button variant="accent" onClick={activateNow} disabled={busy || code.replace(/\s/g, "").length < 6}>Activer</Button>
        </div>
      )}
      {codes && (
        <div className="mt-3 rounded-xl border border-positive/40 bg-positive-bg p-3">
          <p className="text-xs">Codes de secours — affichés une seule fois. Conservez-les hors de l'ordinateur.</p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      {data.enabled && data.source === "settings" && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted">Désactiver</summary>
          <div className="mt-2 space-y-2">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mot de passe" aria-label="Mot de passe pour désactiver" className={inputCls} />
            <input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="Code ou code de secours" aria-label="Code pour désactiver" className={inputCls} />
            <Button variant="secondary" onClick={disableNow} disabled={busy || !password || !disableCode}>Désactiver</Button>
          </div>
        </details>
      )}
      {data.enabled && data.source === "env" && <p className="mt-2 text-xs text-muted">Définie par <code className="font-mono">TOTP_SECRET</code> : retirez la variable puis redémarrez.</p>}
      {msg && <p role="alert" className="mt-2 text-xs text-negative">{msg}</p>}
    </div>
  );
}

type Fresh = { key: string; label: string; state: "ok" | "stale" | "error" | "never"; lastData: string | null; thresholdDays: number; detail: string };
const FRESH_TONE = { ok: "positive", stale: "neutral", error: "negative", never: "negative" } as const;
const FRESH_LABEL = { ok: "À jour", stale: "Périmé", error: "En erreur", never: "Jamais reçu" } as const;

function FreshnessCard() {
  const { data } = useData<Fresh[]>("/api/freshness");
  const bad = (data ?? []).filter((f) => f.state !== "ok");
  return (
    <Card title="État des sources" action={<span className="text-xs text-muted">Dernière donnée, pas dernier essai</span>}>
      {!data ? <KpiSkeleton /> : data.length === 0 ? <EmptyBox>Aucune source suivie pour l'instant.</EmptyBox> : (
        <>
          <p className="text-sm">{bad.length === 0 ? "Toutes les sources sont à jour." : `${bad.length} source${bad.length > 1 ? "s" : ""} à vérifier.`}</p>
          <ul className="mt-2 divide-y divide-rule">
            {data.slice(0, 12).map((f) => (
              <li key={f.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
                <span className="shrink-0 text-xs text-muted">{f.lastData ?? "—"}</span>
                <Pill tone={FRESH_TONE[f.state]}>{FRESH_LABEL[f.state]}</Pill>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export function SettingsView({ go }: { go?: (n: Record<string, string | undefined>) => void } = {}) {
  const { data: o, error, reload } = useData<Ops>("/api/ops");
  const { data: auth } = useData<{ totp: boolean }>("/api/auth-config");
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [pass, setPass] = useState("");
  const [passAdmin, setPassAdmin] = useState("");
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0 lg:col-span-2"><HealthWeights /></div>
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
          ) : <EmptyBox>Veille non configurée : renseignez <code className="font-mono">BACKUP_URL</code> dans le fichier .env, puis redémarrez l'instance.</EmptyBox>}
          <p className="mt-3 text-xs text-muted">Une alerte part sur votre téléphone après 10 minutes sans réponse, puis au retour.</p>
        </Card>
        <Card title="Notifications sur le téléphone">
          {o.ntfyVia === "connexion" ? (
            <>
              <p className="text-sm">ntfy est connecté : le sujet est enregistré, chiffré, dans Connexions.</p>
              <div className="mt-4 flex items-center gap-3"><Button variant="secondary" onClick={() => run("ntfy", "/api/ops/test-notification", "Envoyée")}>Envoyer un essai</Button><Status>{msg.ntfy}</Status></div>
            </>
          ) : o.ntfy ? (
            <>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                <li>Installez l'application gratuite <b>ntfy</b> (Play Store ou App Store).</li>
                <li>Touchez « + » et abonnez-vous au sujet : <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs">{o.ntfy}</code></li>
                <li>Envoyez une notification d'essai.</li>
              </ol>
              <p className="mt-3 text-xs text-muted">Vous recevrez : site hors ligne, relevé en erreur, baisse de plus de 30 % sur une semaine, nouvelle vente, relances du jour. Gardez ce nom de sujet pour vous : il fait office de clé.</p>
              <div className="mt-4 flex items-center gap-3"><Button variant="secondary" onClick={() => run("ntfy", "/api/ops/test-notification", "Envoyée")}>Envoyer un essai</Button><Status>{msg.ntfy}</Status></div>
            </>
          ) : <EmptyBox>ntfy n'est pas connecté : ajoutez-le dans Connexions.{go && <> <button onClick={() => go({ view: "connections" })} className="text-ink underline">Ouvrir Connexions</button></>}</EmptyBox>}
        </Card>
        <Card title="Sauvegardes">
          <p className="text-sm">
            Chaque nuit : une copie locale dans le volume de l'instance ({o.backups.dir}, 14 jours)
            {o.offsiteConfigured ? " et une copie compressée chez Cloudflare (30 jours)." : "."}
          </p>
          {!o.offsiteConfigured && <p className="mt-1 text-xs text-muted">La copie externe n'est pas configurée (BACKUP_URL et BACKUP_TOKEN).</p>}
          {o.offsiteConfigured && <p className="mt-2 text-sm text-muted">Dernière copie externe : {o.backups.offsite ? `${when(o.backups.offsite.at)} · ${Math.round(o.backups.offsite.bytes / 1024)} Ko` : "aucune pour l'instant"}</p>}
          <p className="mt-1 text-sm text-muted">Copies locales : {o.backups.local.length ? o.backups.local.join(", ") : "aucune pour l'instant"}</p>
          <p className="mt-1 text-sm text-muted">Dernière restauration vérifiée : {o.backups.verified ? `${when(o.backups.verified.at)} · ${o.backups.verified.ok ? "OK" : `échec — ${o.backups.verified.detail}`}` : "jamais"}</p>
          {o.offsiteConfigured && !o.backups.passphrase && <p className="mt-1 text-xs text-negative">Copie externe refusée : définissez une phrase de passe de sauvegarde.</p>}
          <div className="mt-2"><Button variant="secondary" onClick={() => run("verify", "/api/ops/backup/verify", "Vérifiée")}>Vérifier la dernière sauvegarde</Button> <Status>{msg.verify}</Status></div>
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-sm">Phrase de passe de la copie externe {o.backups.passphrase ? <span className="text-muted">(déjà définie{o.backups.passFingerprint ? ` · ${o.backups.passFingerprint}` : ""}{o.backups.passSource === "env" ? " · variable d'environnement" : ""})</span> : <span className="text-negative">(non définie)</span>}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="16 caractères minimum" aria-label="Phrase de passe de sauvegarde" className={`${inputCls} max-w-xs`} />
              <input type="password" value={passAdmin} onChange={(e) => setPassAdmin(e.target.value)} placeholder="Mot de passe administrateur" aria-label="Mot de passe administrateur" className={`${inputCls} max-w-xs`} />
              <Button variant="secondary" onClick={async () => {
                try { await api("/api/ops/backup-passphrase", { method: "POST", json: { passphrase: pass, password: passAdmin } }); setPass(""); setPassAdmin(""); setMsg((m) => ({ ...m, pass: "Enregistrée" })); reload(); }
                catch (e) { setMsg((m) => ({ ...m, pass: (e as Error).message })); }
              }}>Enregistrer la phrase</Button>
              <Status>{msg.pass}</Status>
            </div>
            <p className="mt-1 text-xs text-muted">Phrase perdue = lots chiffrés illisibles. Elle protège la seule copie qui quitte la machine.</p>
          </div>
          {o.docker && <p className="mt-2 text-xs text-muted">En Docker, copiez le volume sur votre ordinateur : <code className="font-mono break-all">docker cp &lt;nom-du-conteneur&gt;:/data/backups ./sauvegardes</code></p>}
          <div className="mt-4 flex items-center gap-3"><Button variant="secondary" onClick={() => run("backup", "/api/ops/backup", "Sauvegarde envoyée")}>Sauvegarder maintenant</Button><Status>{msg.backup}</Status></div>
        </Card>
        <Card title="Instance">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center justify-between gap-3"><span>Version</span><span className="num">{o.version}</span></li>
            <li className="flex items-center justify-between gap-3"><span>Dernière migration</span><span className="num">{o.migration ? when(o.migration) : "aucune"}</span></li>
            <li className="flex items-center justify-between gap-3"><span>Fuseau des journées</span><code className="font-mono text-xs">{o.tz}</code></li>
          </ul>
          <p className="mt-3 text-xs text-muted">Le fuseau vient de <code className="font-mono">DAY_TZ</code> et n'est pas modifiable ici : le changer recouperait les journées déjà enregistrées. Un redémarrage est nécessaire après modification.</p>
        </Card>
        <FreshnessCard />
        <DiagnosticCard />
        <div className="min-w-0 lg:col-span-2"><JobsCard /></div>
        <Card title="Rapport hebdomadaire">
          <p className="text-sm">Chaque lundi à 8 h, le point de la semaine par e-mail (module Notifications).</p>
          {go && <div className="mt-4"><Button variant="secondary" onClick={() => go({ view: "report" })}>Voir le rapport de la semaine</Button></div>}
        </Card>
        <Card title="Sécurité">
          <TwoFactor onChanged={reload} />
          <ul className="mt-3 space-y-2 border-t border-rule pt-3 text-sm">
            <li className="flex items-center justify-between gap-3"><span>Essais de connexion limités</span><Pill tone="positive">5 par 15 min</Pill></li>
            <li className="flex items-center justify-between gap-3"><span>Rapport et alertes par e-mail</span>{o.mail ? <Pill tone="positive">Branché</Pill> : <Pill>Non branché</Pill>}</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
