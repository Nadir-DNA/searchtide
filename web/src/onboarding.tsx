// Parcours guidé du premier lancement : quatre étapes, chacune vérifiée par les données réelles,
// affichées seulement quand la base est vide (aucun site, aucun projet).
import { useEffect, useState } from "react";
import { api, type Site } from "./api";
import { Card } from "./ui";

const inputCls =
  "mt-2 w-full rounded-xl border border-border bg-raised px-3 py-2.5 text-sm outline-none focus:border-accent";

type Projects = { id: string; name: string }[];

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
        <span className={`num grid size-6 shrink-0 place-items-center rounded-full text-xs ${done ? "bg-positive-bg text-positive" : "bg-raised text-muted"}`}>
          {done ? "✓" : n}
        </span>
        {title}
      </h3>
      <div className="mt-3 pl-8.5">{children}</div>
    </div>
  );
}

export function Onboarding({ go }: { go: (n: Record<string, string | undefined>) => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState("");
  const [key, setKey] = useState("");

  const load = () => api<Site[]>("/api/sites").then(setSites).catch(() => setSites([]));
  useEffect(() => { load(); }, []);

  async function addSite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const s = await api<Site>("/api/sites", { method: "POST", json: { domain: domain.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") } });
      setDomain(""); setError(""); await load(); go({ site: s.domain, tab: "setup" });
    } catch (err) { setError((err as Error).message); }
  }

  const site = sites?.[0];

  return (
    <>
      <header className="pt-4 pb-6 md:min-h-20 md:pt-6">
        <h1 className="text-2xl leading-9 font-light md:text-[30px] md:leading-10">Bienvenue</h1>
        <p className="mt-1 text-sm text-muted">
          Quatre étapes, cinq minutes. Chaque étape se voit terminée ici, mais vous pouvez revenir plus tard.
        </p>
      </header>

      <div className="grid gap-5 lg:max-w-3xl">
        <Card>
          <div className="space-y-5">
            <Step n={1} title="Ajouter votre premier site" done={!!site}>
              {site ? (
                <p className="text-sm text-muted">
                  {site.domain} est suivi.{" "}
                  <button type="button" className="text-ink hover:underline" onClick={() => go({ site: site.domain, tab: "setup" })}>
                    Voir le script d'installation
                  </button>
                </p>
              ) : (
                <form onSubmit={addSite}>
                  <label className="block text-sm">Domaine
                    <input
                      value={domain} onChange={(e) => setDomain(e.target.value)} required autoFocus
                      placeholder="exemple.com" className={`${inputCls} font-mono`}
                    />
                  </label>
                  <p className="mt-2 text-xs text-muted">Sans https:// ni www. Les sous-domaines sont comptés avec le domaine.</p>
                  {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
                  <button type="submit" className="mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-[var(--color-accent-ink)]">
                    Ajouter le site
                  </button>
                </form>
              )}
            </Step>

            <Step n={2} title="Coller le script dans le site" done={!!site}>
              <p className="mb-2 text-sm text-muted">Dans le <code className="font-mono">&lt;head&gt;</code> de chaque page :</p>
              <Copiable text={`<script defer src="${location.origin}/script.js" data-site="${site?.domain ?? "exemple.com"}"></script>`} />
              <p className="mt-2 text-xs text-muted">
                Les visiteurs apparaissent en quelques minutes. Ouvrez une fois vos pages avec{" "}
                <code className="font-mono">?searchtide=ignore</code> pour ne pas compter vos propres visites.
              </p>
            </Step>

            <Step n={3} title="Créer un projet (facultatif)" done={false}>
              <p className="mb-3 text-sm text-muted">
                Un projet réunit un site, des indicateurs (chiffre d'affaires, clients, inscriptions) et un entonnoir.
                Sans projet, le tableau de bord montre déjà le trafic et le SEO Google.
              </p>
              <button type="button" onClick={() => go({ view: "newproject" })} className="rounded-xl border border-border px-4 py-2.5 text-sm hover:border-accent">
                Créer mon premier projet
              </button>
            </Step>

            <Step n={4} title="Brancher Google Search Console (facultatif)" done={false}>
              <p className="text-sm text-muted">
                Les clics et les mots-clés Google demandent une clé de compte de service, gratuite. La marche à suivre
                complète est dans le README, section « Brancher Google Search Console ».
              </p>
            </Step>

            <Step n={5} title="Donner accès à un agent IA (facultatif)" done={false}>
              <div className="space-y-2">
                <label className="block text-sm">Clé d'API de l'instance
                  <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="celle de API_KEY dans .env" className={`${inputCls} font-mono text-xs`} />
                </label>
                <Copiable text={`claude mcp add --transport http searchtide ${location.origin}/mcp --header "Authorization: Bearer ${key || "VOTRE_CLE"}"`} />
                <p className="text-xs text-muted">
                  Pour un accès en lecture seule, utilisez <code className="font-mono">API_KEY_READ</code> : l'agent lit les chiffres sans rien modifier.
                </p>
              </div>
            </Step>
          </div>
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Vous avez déjà votre tableau de bord ailleurs ? Vous pouvez tout saisir à la main, projet par projet.</p>
            <button type="button" onClick={() => go({ view: "settings" })} className="flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm hover:border-accent">
              Réglages
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}
