// Réglages : surveillance, sauvegardes, notifications et sécurité de l'instance.
import { useState } from "react";
import { api } from "./api";
import { ErrorLine, Header, KpiSkeleton, useData } from "./App";
import { Button, Card, EmptyBox, Pill } from "./ui";

type Ops = {
  ntfy: string | null; ntfyVia: "connexion" | "env" | null; mail: boolean;
  veille: { name: string; up: boolean; since?: number; error?: string }[] | null;
  backups: { local: string[]; dir: string; offsite: { at: number; bytes: number } | null };
};
const when = (t: number) => new Date(t).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

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
