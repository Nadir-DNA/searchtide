// Parcours guidé du premier lancement : quatre étapes, chacune cochée d'après les données réelles (site, connexion, projet, clé d'agent).
// Affiché tant que la base est vide, ou à la demande depuis le menu « Démarrage ». « Passer pour l'instant » est toujours possible.
import { useEffect, useRef, useState } from "react";
import { api, type Site } from "./api";
import { Drawer, useCatalog } from "./connections";
import { Button, Card, inputCls } from "./ui";

export const SKIP_KEY = "searchtide-demarrage-passe";
type Go = (n: Record<string, string | undefined>) => void;
type AgentKey = { id: string; name: string };

function Copiable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-border bg-raised px-3 py-2.5 font-mono text-xs leading-5">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
        className="shrink-0 rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-ink"
      >
        {done ? "Copié" : "Copier"}
      </button>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <div className="border-t border-rule pt-5 first:border-0 first:pt-0">
      <h3 className="flex items-center gap-2.5 text-base font-light">
        <span aria-hidden className={`num grid size-6 shrink-0 place-items-center rounded-full text-xs ${done ? "bg-positive-bg text-positive" : "bg-raised text-muted"}`}>
          {done ? "✓" : n}
        </span>
        <span>{title}<span className="sr-only">{done ? " (terminée)" : " (à faire)"}</span></span>
      </h3>
      <div className="mt-3 pl-8.5">{children}</div>
    </div>
  );
}

export function Onboarding({ go }: { go: Go }) {
  const { catalog, reload: reloadCatalog } = useCatalog();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [projects, setProjects] = useState<{ id: string }[] | null>(null);
  const [agents, setAgents] = useState<AgentKey[] | null>(null);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openDrawer = (id: string) => { opener.current = document.activeElement as HTMLElement | null; setOpen(id); };
  const closeDrawer = () => setOpen(null);
  // Le focus revient à la carte (CA23), après le démontage du tiroir pour que son piège à focus ne le reprenne pas
  useEffect(() => { if (open === null) opener.current?.focus(); }, [open]);
  const [agentName, setAgentName] = useState("");
  const [agentKey, setAgentKey] = useState<{ name: string; key: string } | null>(null);
  const [agentError, setAgentError] = useState("");

  const load = () => {
    api<Site[]>("/api/sites").then(setSites).catch(() => setSites([]));
    api<{ id: string }[]>("/api/projects?days=1").then(setProjects).catch(() => setProjects([]));
    api<AgentKey[]>("/api/agents").then(setAgents).catch(() => setAgents([]));
  };
  useEffect(load, []);

  async function addSite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await api<Site>("/api/sites", { method: "POST", json: { domain: domain.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") } });
      setDomain(""); setError(""); load();
    } catch (err) { setError((err as Error).message); }
  }
  async function createAgent(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const k = await api<{ name: string; key: string }>("/api/agents", { method: "POST", json: { name: agentName.trim() || "Mon agent", read_only: false } });
      setAgentKey(k); setAgentName(""); setAgentError(""); load();
    } catch (err) { setAgentError((err as Error).message); }
  }

  const site = sites?.[0];
  const connections = catalog?.connectors.flatMap((c) => c.connections) ?? [];
  const recommended = ["stripe", "google", "smtp"].map((id) => catalog?.connectors.find((c) => c.id === id)).filter(Boolean) as NonNullable<typeof catalog>["connectors"];
  const ntfy = catalog?.connectors.find((c) => c.id === "ntfy");
  const manifest = catalog?.connectors.find((c) => c.id === open);
  const total = catalog?.connectors.filter((c) => !c.builtin).length ?? 0;
  const done = [!!site, connections.length > 0, !!projects?.length, !!agents?.length];
  const count = done.filter(Boolean).length;

  const leave = () => { localStorage.setItem(SKIP_KEY, "1"); go({ view: undefined, site: undefined, id: undefined, tab: undefined }); };

  const tile = (c: (typeof recommended)[number]) => (
    <button key={c.id} type="button" onClick={() => openDrawer(c.id)} aria-label={`${c.name} : ${c.connections.length ? "connecté" : "non connecté"}, ${c.minutes} minutes environ`}
      className="flex min-w-0 flex-col items-start gap-1 rounded-xl border border-border bg-raised px-4 py-3 text-left hover:border-accent focus-visible:outline-2 focus-visible:outline-accent">
      <span className="flex items-center gap-2.5 text-sm">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-xs font-medium text-muted">{c.monogram}</span>
        <span className="break-words">{c.name}</span>
      </span>
      <span className={`text-xs ${c.connections.length ? "text-positive" : "text-muted"}`}>{c.connections.length ? "● Connecté" : `~${c.minutes} min`}</span>
    </button>
  );

  return (
    <>
      <header className="pt-4 pb-6 md:min-h-20 md:pt-6">
        <h1 className="text-2xl leading-9 font-light md:text-[30px] md:leading-10">Bienvenue</h1>
        <p className="mt-1 text-sm text-muted">
          Quatre étapes. Chacune se voit terminée ici d'après vos données réelles, et vous pouvez revenir plus tard : l'écran « Démarrage » reste dans le menu.
        </p>
      </header>

      <div className="grid gap-5 lg:max-w-3xl">
        <Card>
          <div className="space-y-5">
            <Step n={1} title="Ajouter votre site et coller le script" done={done[0]}>
              {site ? (
                <p className="mb-3 text-sm text-muted">
                  {site.domain} est suivi.{" "}
                  <button type="button" className="text-ink hover:underline" onClick={() => go({ site: site.domain, tab: "setup" })}>Voir l'installation complète</button>
                </p>
              ) : (
                <form onSubmit={addSite} className="mb-4">
                  <label className="block text-sm">Domaine
                    <input value={domain} onChange={(e) => setDomain(e.target.value)} required autoFocus placeholder="exemple.com" className={`${inputCls} mt-2 font-mono`} />
                  </label>
                  <p className="mt-2 text-xs text-muted">Sans https:// ni www. Les sous-domaines sont comptés avec le domaine.</p>
                  {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
                  <Button type="submit" variant="accent" className="mt-4">Ajouter le site</Button>
                </form>
              )}
              <p className="mb-2 text-sm text-muted">Collez ce script dans le <code className="font-mono">&lt;head&gt;</code> de chaque page :</p>
              <Copiable text={`<script defer src="${location.origin}/script.js" data-site="${site?.domain ?? "exemple.com"}"></script>`} />
              <p className="mt-2 text-xs text-muted">
                Les visiteurs apparaissent en quelques minutes. Ouvrez une fois vos pages avec <code className="font-mono">?searchtide=ignore</code> pour ne pas compter vos propres visites.
              </p>
            </Step>

            <Step n={2} title="Connecter vos services" done={done[1]}>
              <p className="mb-3 text-sm text-muted">Trois services suffisent pour commencer. Les autres attendent dans Connexions. Aucun fichier à modifier, aucun redémarrage.</p>
              {catalog ? <div className="grid gap-3 sm:grid-cols-3">{recommended.map(tile)}</div> : <p className="text-sm text-muted">Chargement…</p>}
              <p className="mt-3 text-sm text-muted">
                {ntfy && <><button type="button" onClick={() => openDrawer("ntfy")} className="text-ink underline">ntfy</button> (alertes sur le téléphone, ~{ntfy.minutes} min) · </>}
                <button type="button" onClick={() => go({ view: "connections", site: undefined, id: undefined })} className="text-ink underline">Voir les {total || 7} connecteurs →</button>
              </p>
            </Step>

            <Step n={3} title="Créer un projet et lui rattacher vos sources" done={done[2]}>
              <p className="mb-3 text-sm text-muted">
                Un projet réunit un ou plusieurs sites et des indicateurs (chiffre d'affaires, clients, inscriptions). Sur sa page, la section « Sources » rattache vos connexions en quelques clics.
              </p>
              <Button type="button" variant="secondary" onClick={() => go({ view: "newproject", site: undefined, id: undefined })}>
                {done[2] ? "Créer un autre projet" : "Créer mon premier projet"}
              </Button>
            </Step>

            <Step n={4} title="Donner accès à un agent IA (facultatif)" done={done[3]}>
              {agentKey ? (
                <div className="space-y-2">
                  <p className="text-sm">Clé de « {agentKey.name} » : copiez la commande maintenant, la clé ne sera plus jamais affichée.</p>
                  <Copiable text={`claude mcp add --transport http searchtide ${location.origin}/mcp --header "Authorization: Bearer ${agentKey.key}"`} />
                  <p className="text-xs text-muted">Une clé par agent, révocable dans « Agents IA », qui journalise chacun de ses appels.</p>
                </div>
              ) : (
                <form onSubmit={createAgent} className="space-y-2">
                  {done[3] && <p className="text-sm text-muted">Une clé existe déjà : gérez-les dans <button type="button" onClick={() => go({ view: "agents", site: undefined, id: undefined })} className="text-ink underline">Agents IA</button>.</p>}
                  <label className="block text-sm">Nom de l'agent
                    <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Claude Code" maxLength={60} className={`${inputCls} mt-2`} />
                  </label>
                  {agentError && <p role="alert" className="text-sm text-negative">{agentError}</p>}
                  <Button type="submit" variant="secondary">Créer une clé pour cet agent</Button>
                </form>
              )}
            </Step>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">{count} étape{count > 1 ? "s" : ""} sur 4 terminée{count > 1 ? "s" : ""}.</p>
          <button type="button" onClick={leave} className="rounded-xl border border-border px-4 py-2.5 text-sm hover:border-accent">Passer pour l'instant</button>
        </div>
      </div>

      {manifest && catalog && <Drawer key={manifest.id} m={manifest} catalog={catalog} onClose={closeDrawer} reload={reloadCatalog} />}
    </>
  );
}
