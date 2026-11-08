import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, AuthError, type Search, type Site, type Traffic, type Row } from "./api";
import { Button, Card, LineChart, Stat, Table, fieldCls, fmt, inputCls } from "./ui";

const CHANNELS: Record<string, string> = {
  direct: "Direct", search: "Moteurs de recherche", social: "Réseaux sociaux", ai: "Assistants IA",
  referral: "Sites référents", email: "Email", paid: "Publicité",
};
const rowCols = (label: string, map?: Record<string, string>) => [
  { label, render: (r: Row) => map?.[r.key] ?? r.key },
  { label: "Visiteurs", render: (r: Row) => fmt(r.visitors), num: true },
  { label: "Pages vues", render: (r: Row) => fmt(r.pageviews), num: true },
];

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [gsc, setGsc] = useState(false);
  useEffect(() => {
    api<{ gsc: boolean }>("/api/me").then((m) => { setGsc(m.gsc); setAuthed(true); }).catch(() => setAuthed(false));
  }, []);
  if (authed === null) return null;
  return authed ? <Dashboard gsc={gsc} onLogout={() => setAuthed(false)} /> : <Login onDone={() => location.reload()} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = new FormData(e.currentTarget).get("password");
    try { await api("/api/login", { method: "POST", json: { password } }); onDone(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-xs space-y-3">
        <h1 className="text-xl font-semibold">Searchtide</h1>
        <label className="block text-sm">Mot de passe
          <input name="password" type="password" autoFocus required className={`${inputCls} mt-1`} />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <Button className="w-full">Se connecter</Button>
      </form>
    </main>
  );
}

function Dashboard({ gsc, onLogout }: { gsc: boolean; onLogout: () => void }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [current, setCurrent] = useState<string | null>(() => new URLSearchParams(location.search).get("site"));
  const load = useCallback(() => api<Site[]>("/api/sites").then(setSites).catch((e) => e instanceof AuthError && onLogout()), [onLogout]);
  useEffect(() => { load(); }, [load]);
  const site = sites.find((s) => s.domain === current) ?? sites[0];

  function select(domain: string) {
    setCurrent(domain);
    history.replaceState(null, "", `?site=${domain}`);
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row">
      <aside className="md:w-56 md:shrink-0">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-tide-700 dark:text-tide-500">Searchtide</span>
          <button className="text-xs text-stone-400 hover:underline" onClick={() => api("/api/logout", { method: "POST" }).then(onLogout)}>Déconnexion</button>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Sites">
          {sites.map((s) => (
            <button key={s.id} onClick={() => select(s.domain)} aria-current={s.id === site?.id}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap ${s.id === site?.id ? "bg-tide-50 font-medium text-tide-700 dark:bg-tide-700/20 dark:text-tide-100" : "hover:bg-stone-100 dark:hover:bg-stone-800"}`}>
              {s.domain}<span className="num ml-2 text-xs text-stone-400">{s.today || ""}</span>
            </button>
          ))}
        </nav>
        <AddSite onAdded={(s) => { load(); select(s.domain); }} />
      </aside>
      <main className="min-w-0 flex-1">
        {site ? <SiteView key={site.id} site={site} gsc={gsc} onChange={load} /> : (
          <Card><p className="text-sm">Ajoutez votre premier site pour commencer.</p></Card>
        )}
      </main>
    </div>
  );
}

function AddSite({ onAdded }: { onAdded: (s: Site) => void }) {
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      const s = await api<Site>("/api/sites", { method: "POST", json: { domain: new FormData(form).get("domain") } });
      form.reset(); setError(""); onAdded(s);
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <form onSubmit={submit} className="mt-4 space-y-2">
      <label className="block text-xs text-stone-500">Ajouter un site
        <input name="domain" placeholder="exemple.com" required className={`${inputCls} mt-1`} />
      </label>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <Button className="w-full">Ajouter</Button>
    </form>
  );
}

const PERIODS = [[7, "7 jours"], [28, "28 jours"], [90, "3 mois"], [365, "12 mois"]] as const;

function SiteView({ site, gsc, onChange }: { site: Site; gsc: boolean; onChange: () => void }) {
  const [tab, setTab] = useState<"traffic" | "search" | "setup">("traffic");
  const [days, setDays] = useState(28);
  const tabs = [["traffic", "Trafic"], ["search", "Recherche Google"], ["setup", "Installation"]] as const;
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{site.name}</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={fieldCls} aria-label="Période">
          {PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
        </select>
      </header>
      <div role="tablist" className="flex gap-4 border-b border-stone-200 dark:border-stone-800">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 pb-2 text-sm ${tab === k ? "border-tide-600 font-medium" : "border-transparent text-stone-500"}`}>{l}</button>
        ))}
      </div>
      {tab === "traffic" && <TrafficView site={site} days={days} />}
      {tab === "search" && <SearchView site={site} days={days} gsc={gsc} onChange={onChange} />}
      {tab === "setup" && <SetupView site={site} gsc={gsc} onChange={onChange} />}
    </div>
  );
}

function useData<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => { api<T>(url).then(setData).catch((e) => setError(e.message)); }, [url]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function TrafficView({ site, days }: { site: Site; days: number }) {
  const { data: t, error } = useData<Traffic>(`/api/sites/${site.id}/traffic?days=${days}`);
  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (!t) return null;
  if (!t.totals.pageviews) return <Card><p className="text-sm">Aucune visite sur la période. Vérifiez l'installation du script (onglet Installation).</p></Card>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Visiteurs" value={fmt(t.totals.visitors)} hint="uniques par jour" />
        <Stat label="Pages vues" value={fmt(t.totals.pageviews)} />
        <Stat label="Pages / visiteur" value={fmt(t.totals.pageviews / t.totals.visitors, 1)} />
        <Stat label="Depuis les IA" value={fmt(t.aiReferrers.reduce((n, r) => n + r.visitors, 0))} hint="ChatGPT, Perplexity, Claude…" />
      </div>
      <Card title="Visiteurs par jour"><LineChart label="Visiteurs par jour" points={t.daily.map((d) => ({ x: d.day, y: d.visitors }))} /></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pages"><Table rows={t.pages} cols={rowCols("Page")} /></Card>
        <Card title="Canaux"><Table rows={t.channels} cols={rowCols("Canal", CHANNELS)} /></Card>
        <Card title="Référents"><Table rows={t.referrers} cols={rowCols("Site")} /></Card>
        <Card title="Assistants IA"><Table rows={t.aiReferrers} cols={rowCols("Assistant")} empty="Aucune visite venant d'une IA." /></Card>
        <Card title="Pays"><Table rows={t.countries} cols={rowCols("Pays")} empty="Pays indisponible (voir README)." /></Card>
        <Card title="Appareils"><Table rows={t.devices} cols={rowCols("Appareil")} /></Card>
        <Card title="Navigateurs"><Table rows={t.browsers} cols={rowCols("Navigateur")} /></Card>
        <Card title="Campagnes (UTM)"><Table rows={t.campaigns} cols={rowCols("Campagne")} empty="Aucune campagne." /></Card>
      </div>
    </div>
  );
}

const searchCols = <T extends { clicks: number; impressions: number; ctr?: number; position: number }>(label: string, key: (r: T) => string) => [
  { label, render: (r: T) => key(r) },
  { label: "Clics", render: (r: T) => fmt(r.clicks), num: true },
  { label: "Impr.", render: (r: T) => fmt(r.impressions), num: true },
  { label: "Position", render: (r: T) => fmt(r.position, 1), num: true },
];

function SearchView({ site, days, gsc, onChange }: { site: Site; days: number; gsc: boolean; onChange: () => void }) {
  const { data: s, error, reload } = useData<Search>(`/api/sites/${site.id}/search?days=${days}`);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  async function sync() {
    setSyncing(true); setSyncError("");
    try { await api(`/api/sites/${site.id}/sync`, { method: "POST" }); reload(); onChange(); }
    catch (e) { setSyncError((e as Error).message); }
    setSyncing(false);
  }
  if (!gsc || !site.gsc_property) return <Card><p className="text-sm">Reliez ce site à Google Search Console dans l'onglet Installation.</p></Card>;
  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (!s) return null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-stone-500">
        <span>{site.synced_at ? `Dernière synchro : ${new Date(site.synced_at).toLocaleString("fr-FR")}` : "Jamais synchronisé"}</span>
        <Button onClick={sync} disabled={syncing}>{syncing ? "Synchronisation…" : "Synchroniser"}</Button>
        {(syncError || site.sync_error) && <span role="alert" className="text-red-600">{syncError || site.sync_error}</span>}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Clics" value={fmt(s.totals.clicks)} />
        <Stat label="Impressions" value={fmt(s.totals.impressions)} />
        <Stat label="CTR" value={`${fmt(s.totals.ctr, 1)} %`} />
        <Stat label="Position moyenne" value={fmt(s.totals.position, 1)} />
      </div>
      <Card title="Clics par jour"><LineChart label="Clics par jour" points={s.daily.map((d) => ({ x: d.day, y: d.clicks }))} /></Card>
      <Card title="Opportunités : mots-clés en position 4 à 20, à faire monter en première page">
        <Table rows={s.opportunities} cols={searchCols<Search["opportunities"][number]>("Mot-clé", (r) => r.query)} empty="Aucune opportunité pour l'instant." />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mots-clés"><Table rows={s.queries} cols={searchCols<Search["queries"][number]>("Mot-clé", (r) => r.query)} /></Card>
        <Card title="Pages"><Table rows={s.pages} cols={searchCols<Search["pages"][number]>("Page", (r) => r.page.replace(/^https?:\/\/[^/]+/, "") || "/")} /></Card>
      </div>
    </div>
  );
}

function SetupView({ site, gsc, onChange }: { site: Site; gsc: boolean; onChange: () => void }) {
  const snippet = `<script defer src="${location.origin}/script.js" data-site="${site.domain}"></script>`;
  const [props, setProps] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (gsc) api<string[]>("/api/gsc/properties").then(setProps).catch((e) => setError(e.message));
  }, [gsc]);
  async function link(gsc_property: string) {
    await api(`/api/sites/${site.id}`, { method: "PATCH", json: { gsc_property } });
    onChange();
  }
  async function remove() {
    if (!confirm(`Supprimer ${site.domain} et toutes ses données ? C'est irréversible.`)) return;
    await api(`/api/sites/${site.id}`, { method: "DELETE" });
    location.search = "";
  }
  return (
    <div className="space-y-4">
      <Card title="1. Script de suivi">
        <p className="mb-2 text-sm">Collez cette ligne dans le <code>&lt;head&gt;</code> de chaque page. Sans cookie : pas de bannière nécessaire.</p>
        <pre className="overflow-x-auto rounded-lg bg-stone-100 p-3 text-xs dark:bg-stone-800"><code>{snippet}</code></pre>
        <p className="mt-2 text-xs text-stone-500">Événement personnalisé : <code>searchtide("inscription")</code> ou attribut <code>data-searchtide="clic-cta"</code>.</p>
      </Card>
      <Card title="2. Google Search Console">
        {!gsc ? (
          <p className="text-sm">Non configuré. Renseignez <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (voir README), puis redémarrez.</p>
        ) : error ? <p role="alert" className="text-sm text-red-600">{error}</p> : (
          <label className="block text-sm">Propriété
            <select className={`${inputCls} mt-1`} value={site.gsc_property ?? ""} onChange={(e) => link(e.target.value)}>
              <option value="">— Non relié —</option>
              {props?.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {props?.length === 0 && <span className="mt-1 block text-xs text-stone-500">Aucune propriété : ajoutez l'email du compte de service comme utilisateur dans Search Console.</span>}
          </label>
        )}
      </Card>
      <Card title="Zone sensible">
        <button onClick={remove} className="text-sm text-red-600 hover:underline">Supprimer ce site</button>
      </Card>
    </div>
  );
}
