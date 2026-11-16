// Onglets d'un projet (spec §5.6) : Vue, Trafic, un onglet par module actif sur le projet, Réglages du projet.
import { lazy, useEffect, useState } from "react";
import { api, type Site } from "../api";
import { useData } from "../App";
import { Drawer, useCatalog } from "../connections";
import { useModules } from "../modules";
import { SettingCard, Copyable, SetupView, TrafficView, type Me } from "../modules/analytics";
import { SearchView } from "../modules/google";
import { CrmView } from "../modules/crm";
import { KpiCatalogPanel } from "../sources";
import { Button, Card, Delta, EmptyBox, KpiCard, Segmented } from "../ui";
import { Sheet } from "../modules/shared";
import { SeoAuditView, SeoContentView } from "../seotools";
import { val } from "../projects";
import { VisibilityView } from "../visibility";
const PubsView = lazy(() => import("../modules/publications").then((m) => ({ default: m.PubsView })));
import { ClientReportCard } from "../client-report";

type Go = (n: Record<string, string | undefined>) => void;
type Project = { id: string; name: string; sites: string[]; crm_key: string | null; indicators: { id: string; label: string; unit: string | null; source: string; mode: string; value: number | null; previous: number | null; last_error: string | null }[] };
// Sources des indicateurs montrés par les onglets Revenus et Produit
const TAB_SOURCES: Record<string, string[]> = { revenus: ["stripe"], produit: ["pg", "supabase", "http"] };

export function useProjectTabs(projectId: string, hasSites: boolean): [string, string][] {
  const { modules, active } = useModules();
  // Publications : un calendrier et des comptes par projet, onglet présent dans chaque projet dès que le module est actif sur l'instance.
  const own = modules.filter((m) => !m.core && m.scope === "projet" && (active(m.id, projectId) || (m.id === "publications" && m.enabled))).flatMap((m) => m.tabs ?? [])
    .filter((t) => t.id !== "recherche" && t.id !== "ia");
  const order = ["revenus", "produit", "contacts", "publications"];
  own.sort((a, b) => (order.indexOf(a.id) + 1 || 9) - (order.indexOf(b.id) + 1 || 9));
  return [["vue", "Vue"], ...(hasSites ? [["trafic", "Trafic"] as [string, string]] : []), ["seo", "SEO"], ...own.map((t) => [t.id, t.label] as [string, string]), ["reglages", "Réglages"]];
}

export function ProjectTabBar({ project, tab, go }: { project: Project; tab: string; go: Go }) {
  const tabs = useProjectTabs(project.id, project.sites.length > 0);
  const current = tab === "recherche" || tab === "ia" ? "seo" : tab;
  return (
    <div className="mb-5 -mt-1 overflow-x-auto">
      <Segmented label="Sections du projet" value={tabs.some(([k]) => k === current) ? current : "vue"} onChange={(v) => go({ tab: v === "vue" ? undefined : v, sub: undefined })} options={tabs} />
    </div>
  );
}

export function ProjectTabBody({ project, tab, sub, domain, openInstall, days, go, me, onChanged }: { project: Project; tab: string; sub?: string; domain?: string; openInstall?: boolean; days: number; go: Go; me: Me; onChanged: () => void }) {
  const { data: sites } = useData<Site[]>("/api/sites");
  const own = (sites ?? []).filter((s) => project.sites.includes(s.domain));
  const [siteDom, setSiteDom] = useState(domain ?? "");
  const [install, setInstall] = useState(!!openInstall);
  const site = own.find((s) => s.domain === (siteDom || domain)) ?? own[0];
  if (tab === "reglages") return <div className="space-y-4"><ProjectSettings project={project} sites={own} onChanged={onChanged} /><ClientReportCard projectId={project.id} /></div>;
  if (tab === "trafic") return (
    <div className="space-y-4">
      {own.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-muted">Site
          <select value={site?.domain ?? ""} onChange={(e) => setSiteDom(e.target.value)} className="rounded-lg border border-control bg-raised px-2 py-1 text-sm text-ink">
            {own.map((s) => <option key={s.id} value={s.domain}>{s.domain}</option>)}
          </select>
        </label>
      )}
      {site ? <TrafficView site={site} days={days} onSetup={() => setInstall(true)} /> : <EmptyBox>Ajoutez un domaine au projet dans « Réglages ».</EmptyBox>}
      {install && site && <Sheet title="Installation du suivi" onClose={() => setInstall(false)}><SetupView site={site} me={me} onChange={onChanged} go={go} /></Sheet>}
    </div>
  );
  if (tab === "seo" || tab === "recherche" || tab === "ia") return <SeoView project={project} sites={own} site={site} onSite={setSiteDom} sub={tab === "recherche" ? "google" : tab === "ia" ? "ia" : sub} days={days} go={go} me={me} onChanged={onChanged} onInstall={() => setInstall(true)} install={install} onCloseInstall={() => setInstall(false)} />;
  if (tab === "publications") return <PubsView q={Object.fromEntries(new URLSearchParams(location.search))} go={go} project={project} />;
  if (tab === "contacts") return <CrmView tab="" go={go} q={{ project: project.id }} />;
  const inds = project.indicators.filter((i) => TAB_SOURCES[tab]?.includes(i.source));
  return inds.length ? (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {inds.map((i) => <KpiCard key={i.id} label={i.label} value={val(i.value, i.unit)} delta={<Delta now={i.value} before={i.previous} />} hint={i.last_error ? `Erreur : ${i.last_error}` : undefined} />)}
    </div>
  ) : <EmptyBox>Aucun indicateur ici pour l'instant : « Ajouter des KPI » dans Réglages.</EmptyBox>;
}

/** SEO d'un projet : Google, audit, contenus et visibilité IA, avec un seul sélecteur de site. */
const SEO_TABS = [["google", "Google"], ["audit", "Audit"], ["contenus", "Contenus"], ["ia", "Visibilité IA"]] as const;
function SeoView({ project, sites, site, onSite, sub, days, go, me, onChanged, onInstall, install, onCloseInstall }: {
  project: Project; sites: Site[]; site?: Site; onSite: (d: string) => void; sub?: string; days: number; go: Go; me: Me;
  onChanged: () => void; onInstall: () => void; install: boolean; onCloseInstall: () => void;
}) {
  const current = (SEO_TABS.some(([k]) => k === sub) ? sub : "google") as (typeof SEO_TABS)[number][0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Sections SEO" value={current} onChange={(v) => go({ sub: v === "google" ? undefined : v })} options={SEO_TABS} />
        {current !== "ia" && sites.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">Site
            <select value={site?.domain ?? ""} onChange={(e) => onSite(e.target.value)} className="rounded-lg border border-control bg-raised px-2 py-1 text-sm text-ink">
              {sites.map((s) => <option key={s.id} value={s.domain}>{s.domain}</option>)}
            </select>
          </label>
        )}
      </div>
      {current === "ia" ? <VisibilityView projectId={project.id} />
        : !site ? <EmptyBox>Ajoutez un domaine au projet dans « Réglages ».</EmptyBox>
        : current === "google" ? <SearchView site={site} me={me} days={days} onChange={onChanged} onSetup={onInstall} />
        : current === "audit" ? <SeoAuditView site={site} demo={me.demo} />
        : <SeoContentView site={site} demo={me.demo} />}
      {install && site && <Sheet title="Installation du suivi" onClose={onCloseInstall}><SetupView site={site} me={me} onChange={onChanged} go={go} /></Sheet>}
    </div>
  );
}

/** Réglages du projet : domaines et script de suivi, modules du projet (connexion dans un tiroir, sans quitter la page), ajout de KPI. */
function ProjectSettings({ project, sites, onChanged }: { project: Project; sites: Site[]; onChanged: () => void }) {
  const { modules, active, reload } = useModules();
  const { catalog, reload: reloadCatalog } = useCatalog();
  const [connecting, setConnecting] = useState<{ module: string; connector: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const own = modules.filter((m) => !m.core && m.scope === "projet");
  const manifest = (id: string) => catalog?.connectors.find((c) => c.id === id);
  const connected = (connectorIds: string[]) => connectorIds.some((c) => (manifest(c)?.connections.length ?? 0) > 0);

  async function toggle(module: string, on: boolean) {
    setError("");
    try { await api(`/api/projects/${project.id}/modules/${module}`, { method: "PUT", json: { enabled: on } }); reload(); onChanged(); }
    catch (e) { setError((e as Error).message); }
  }
  // Une fois la connexion enregistrée dans le tiroir, le module est activé pour ce projet et le tiroir se ferme
  useEffect(() => {
    if (connecting && (manifest(connecting.connector)?.connections.length ?? 0) > 0) { const m = connecting.module; setConnecting(null); void toggle(m, true); }
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = connecting && manifest(connecting.connector);
  return (
    <div className="space-y-4">
      <SettingCard title="Domaines et script de suivi" sub="Les domaines du projet se gèrent dans « Gérer le projet ». Collez le script dans le <head> de chaque site.">
        {sites.length ? <div className="space-y-3">{sites.map((s) => <div key={s.id}><div className="mb-1 text-sm">{s.domain}</div><Copyable text={`<script defer src="${location.origin}/script.js" data-site="${s.domain}"></script>`} /></div>)}</div>
          : <EmptyBox>Aucun domaine pour l'instant.</EmptyBox>}
      </SettingCard>
      <Card title="Modules du projet" action={<Button onClick={() => setAdding(true)}>Ajouter des KPI</Button>}>
        {msg && <p className="mb-3 text-sm text-positive">{msg}</p>}
        {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
        <ul className="divide-y divide-rule">
          {own.map((mod) => {
            const needs = mod.connectors.map((c) => c.id);
            const on = active(mod.id, project.id);
            const ready = !needs.length || connected(needs);
            return (
              <li key={mod.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="min-w-0 flex-1"><span className="block">{mod.name}</span><span className="block text-xs text-muted">{mod.description}</span></span>
                {ready
                  ? <button type="button" role="switch" aria-checked={on} aria-label={mod.name} onClick={() => toggle(mod.id, !on)}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`}>
                      <span className={`absolute top-0.5 size-5 rounded-full bg-surface transition-all ${on ? "left-[22px]" : "left-0.5"}`} aria-hidden />
                    </button>
                  : <Button variant="secondary" onClick={() => setConnecting({ module: mod.id, connector: needs[0] })}>Activer {mod.name}</Button>}
              </li>
            );
          })}
        </ul>
      </Card>
      {m && catalog && <Drawer key={m.id} m={m} catalog={catalog} onClose={() => setConnecting(null)} reload={async () => { await reloadCatalog(); }} />}
      {adding && <KpiCatalogPanel projectId={project.id} onClose={() => setAdding(false)} onAdded={(label) => { setMsg(`« ${label} » ajouté.`); onChanged(); }} />}
    </div>
  );
}
