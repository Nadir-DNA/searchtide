// Onglets d'un projet (spec §5.6) : Vue, Trafic, un onglet par module actif sur le projet, Réglages du projet.
import { useEffect, useState } from "react";
import { api, type Site } from "../api";
import { useData } from "../App";
import { Drawer, useCatalog } from "../connections";
import { useModules } from "../modules";
import { SettingCard, Copyable, TrafficView, type Me } from "../modules/analytics";
import { SearchView } from "../modules/google";
import { CrmView } from "../modules/crm";
import { KpiCatalogPanel } from "../sources";
import { Button, Card, Delta, EmptyBox, KpiCard, Segmented } from "../ui";
import { val } from "../projects";

type Go = (n: Record<string, string | undefined>) => void;
type Project = { id: string; name: string; sites: string[]; crm_key: string | null; indicators: { id: string; label: string; unit: string | null; source: string; mode: string; value: number | null; previous: number | null; last_error: string | null }[] };
// Sources des indicateurs montrés par les onglets Revenus et Produit
const TAB_SOURCES: Record<string, string[]> = { revenus: ["stripe"], produit: ["pg", "supabase", "http"] };

export function useProjectTabs(projectId: string, hasSites: boolean): [string, string][] {
  const { modules, active } = useModules();
  const own = modules.filter((m) => !m.core && m.scope === "projet" && active(m.id, projectId)).flatMap((m) => m.tabs ?? []);
  return [["vue", "Vue"], ...(hasSites ? [["trafic", "Trafic"] as [string, string]] : []), ...own.map((t) => [t.id, t.label] as [string, string]), ["reglages", "Réglages"]];
}

export function ProjectTabBar({ project, tab, go }: { project: Project; tab: string; go: Go }) {
  const tabs = useProjectTabs(project.id, project.sites.length > 0);
  return (
    <div className="mb-5 -mt-1 overflow-x-auto">
      <Segmented label="Sections du projet" value={tabs.some(([k]) => k === tab) ? tab : "vue"} onChange={(v) => go({ tab: v === "vue" ? undefined : v })} options={tabs} />
    </div>
  );
}

export function ProjectTabBody({ project, tab, days, go, me, onChanged }: { project: Project; tab: string; days: number; go: Go; me: Me; onChanged: () => void }) {
  const { data: sites } = useData<Site[]>("/api/sites");
  const own = (sites ?? []).filter((s) => project.sites.includes(s.domain));
  if (tab === "reglages") return <ProjectSettings project={project} sites={own} onChanged={onChanged} />;
  if (tab === "trafic" || tab === "recherche") return (
    <div className="space-y-8">
      {own.map((s) => (
        <section key={s.id} aria-label={s.domain}>
          {own.length > 1 && <h2 className="mb-3 text-lg font-light">{s.domain}</h2>}
          {tab === "trafic" ? <TrafficView site={s} days={days} onSetup={() => go({ tab: "reglages" })} />
            : <SearchView site={s} me={me} days={days} onChange={onChanged} onSetup={() => go({ tab: "reglages" })} />}
        </section>
      ))}
      {!own.length && <EmptyBox>Ajoutez un domaine au projet dans « Réglages ».</EmptyBox>}
    </div>
  );
  if (tab === "contacts") return <CrmView tab="" go={go} q={{ project: project.crm_key ?? "" }} />;
  const inds = project.indicators.filter((i) => TAB_SOURCES[tab]?.includes(i.source));
  return inds.length ? (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {inds.map((i) => <KpiCard key={i.id} label={i.label} value={val(i.value, i.unit)} delta={<Delta now={i.value} before={i.previous} />} hint={i.last_error ? `Erreur : ${i.last_error}` : undefined} />)}
    </div>
  ) : <EmptyBox>Aucun indicateur ici pour l'instant : « Ajouter des KPI » dans Réglages.</EmptyBox>;
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
