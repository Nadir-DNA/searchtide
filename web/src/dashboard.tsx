// Pages personnalisables : une grille de blocs choisis dans un catalogue, rangés à la main (« Personnaliser ») ou par les agents IA (MCP).
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ActivatePrompt } from "./modules/ActivatePrompt";
import { api, type Search, type Site, type Traffic } from "./api";
import { ErrorLine, Header, KpiSkeleton, useData } from "./App";
import { PipelineCard, PubsCard } from "./business";
import { BarChart, fillDays } from "./chart";
import { Matrix, Pulse, Todo, TrafficByProject, type Portfolio } from "./portfolio";
import { GoalBar, val, type Project } from "./projects";
import { Button, Card, Delta, EmptyBox, KpiCard, Table, fmt, inputCls } from "./ui";

type Go = (n: Record<string, string | undefined>) => void;
export type Widget = { id: string; type: string; size: Size; title?: string; options: Record<string, string | number | boolean> };
export type Dashboard = { id: string; name: string; position: number; updated_at: number; updated_by: string | null; widgets: Widget[] };
type Catalog = Record<string, { label: string; description: string; size: Size; options: Record<string, string>; module: string; moduleName: string; available: boolean }>;
type Size = "quarter" | "third" | "half" | "two-thirds" | "full";
export type Dashboards = { dashboards: Dashboard[]; catalog: Catalog; sizes: Size[] };

const SPAN: Record<Size, string> = {
  quarter: "md:col-span-6 lg:col-span-3", third: "md:col-span-6 lg:col-span-4", half: "lg:col-span-6",
  "two-thirds": "lg:col-span-8", full: "",
};
const SIZE_LABEL: Record<Size, string> = { quarter: "1/4", third: "1/3", half: "1/2", "two-thirds": "2/3", full: "Pleine largeur" };
const PORTFOLIO = new Set(["pulse", "traffic_by_project", "todo", "projects_table"]);
const when = (t: number) => new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export function DashboardView({ dash, catalog, sizes, days, go, onChanged }: {
  dash: Dashboard; catalog: Catalog; sizes: Size[]; days: number; go: Go; onChanged: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const [ws, setWs] = useState(dash.widgets);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setWs(dash.widgets), [dash]);
  const needsPortfolio = ws.some((w) => PORTFOLIO.has(w.type));
  const { data: o, error: oError, reload } = useData<Portfolio | null>(needsPortfolio ? `/api/portfolio?days=${days}` : "/api/me");

  async function save(next: Widget[]) {
    setWs(next); setError("");
    try { await api(`/api/dashboards/${dash.id}`, { method: "PUT", json: { widgets: next } }); onChanged(); }
    catch (e) { setError((e as Error).message); setWs(dash.widgets); }
  }
  const move = (i: number, d: number) => { const n = [...ws]; const [w] = n.splice(i, 1); n.splice(Math.max(0, Math.min(i + d, n.length)), 0, w); save(n); };
  const patch = (i: number, p: Partial<Widget>) => save(ws.map((w, k) => k === i ? { ...w, ...p } : w));

  return (
    <>
      <Header title={dash.name} days={days} go={go}
        sub={dash.updated_by && dash.updated_by !== "système" ? `Modifiée par ${dash.updated_by} le ${when(dash.updated_at)}` : undefined}>
        <Button variant={edit ? "primary" : "secondary"} onClick={() => { setEdit(!edit); setAdding(false); }}>{edit ? "Terminer" : "Personnaliser"}</Button>
      </Header>
      {edit && <PageSettings dash={dash} go={go} onChanged={onChanged} />}
      {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
      {oError ? <ErrorLine error={oError} retry={reload} /> : needsPortfolio && !o ? <KpiSkeleton /> : (
        <div className="grid grid-cols-12 gap-4">
          {ws.map((w, i) => (
            <div key={w.id} className={`col-span-12 min-w-0 ${SPAN[w.size] ?? ""} ${edit ? "rounded-2xl outline-2 outline-offset-4 outline-dashed outline-control" : ""}`}>
              {edit && <WidgetBar w={w} i={i} n={ws.length} catalog={catalog} sizes={sizes} onMove={move} onPatch={patch} onRemove={() => save(ws.filter((_, k) => k !== i))} />}
              {catalog[w.type] && !catalog[w.type].available
                ? <ActivatePrompt module={catalog[w.type].module} name={catalog[w.type].moduleName} what={catalog[w.type].description.charAt(0).toLowerCase() + catalog[w.type].description.slice(1).replace(/\.$/, "")} title={w.title ?? catalog[w.type].label} go={go} />
                : <WidgetBody w={w} o={o as Portfolio} days={days} go={go} />}
            </div>
          ))}
          {!ws.length && !edit && <div className="col-span-12"><EmptyBox>Page vide. <button onClick={() => { setEdit(true); setAdding(true); }} className="text-ink underline">Ajouter un bloc</button></EmptyBox></div>}
          {edit && (
            <div className="col-span-12">
              {adding ? <AddWidget catalog={catalog} onAdd={(w) => { save([...ws, w]); setAdding(false); }} onCancel={() => setAdding(false)} />
                : <button onClick={() => setAdding(true)} className="flex h-16 w-full items-center justify-center rounded-2xl border border-dashed border-control text-sm text-muted hover:text-ink">+ Ajouter un bloc</button>}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PageSettings({ dash, go, onChanged }: { dash: Dashboard; go: Go; onChanged: () => void }) {
  const [name, setName] = useState(dash.name);
  const [msg, setMsg] = useState("");
  const call = async (f: () => Promise<unknown>) => { try { setMsg(""); await f(); onChanged(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-3 text-sm">
      <label className="flex items-center gap-2">Nom de la page
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls.replace("h-10 w-full", "h-9")} w-56`} />
      </label>
      <Button variant="secondary" disabled={name === dash.name} onClick={() => call(() => api(`/api/dashboards/${dash.id}`, { method: "PUT", json: { name } }))}>Renommer</Button>
      <button onClick={() => confirm(`Supprimer la page « ${dash.name} » ?`) && call(async () => { await api(`/api/dashboards/${dash.id}`, { method: "DELETE" }); go({ view: undefined, id: undefined }); })}
        className="ml-auto h-9 rounded-full px-3 text-negative hover:bg-negative-bg">Supprimer la page</button>
      {msg && <span role="alert" className="w-full text-negative">{msg}</span>}
    </div>
  );
}

function WidgetBar({ w, i, n, catalog, sizes, onMove, onPatch, onRemove }: {
  w: Widget; i: number; n: number; catalog: Catalog; sizes: Size[]; onMove: (i: number, d: number) => void; onPatch: (i: number, p: Partial<Widget>) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = "grid h-8 min-w-8 place-items-center rounded-lg px-2 text-sm hover:bg-raised disabled:opacity-30";
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1 text-sm">
        <span className="min-w-0 flex-1 truncate text-muted">{catalog[w.type]?.label ?? w.type}</span>
        <button className={btn} disabled={!i} onClick={() => onMove(i, -1)} aria-label="Déplacer avant">←</button>
        <button className={btn} disabled={i === n - 1} onClick={() => onMove(i, 1)} aria-label="Déplacer après">→</button>
        <select aria-label="Largeur" value={w.size} onChange={(e) => onPatch(i, { size: e.target.value as Size })} className="h-8 rounded-lg border border-control bg-raised px-2 text-sm">
          {sizes.map((s) => <option key={s} value={s}>{SIZE_LABEL[s]}</option>)}
        </select>
        <button className={btn} onClick={() => setOpen(!open)}>Réglages</button>
        <button className={`${btn} text-negative`} onClick={onRemove}>Retirer</button>
      </div>
      {open && <WidgetForm type={w.type} catalog={catalog} initial={w} submit="Enregistrer" onSubmit={(p) => { onPatch(i, p); setOpen(false); }} onCancel={() => setOpen(false)} />}
    </div>
  );
}

function AddWidget({ catalog, onAdd, onCancel }: { catalog: Catalog; onAdd: (w: Widget) => void; onCancel: () => void }) {
  const [type, setType] = useState<string | null>(null);
  if (type) return <Card title={`Ajouter : ${catalog[type].label}`}><WidgetForm type={type} catalog={catalog} submit="Ajouter" onCancel={() => setType(null)}
    onSubmit={(p) => onAdd({ id: Math.random().toString(36).slice(2, 10), type, size: catalog[type].size, options: {}, ...p })} /></Card>;
  return (
    <Card title="Ajouter un bloc" action={<button onClick={onCancel} className="text-sm text-muted hover:text-ink">Annuler</button>}>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(catalog).map(([k, c]) => (
          <li key={k}>
            <button disabled={!c.available} onClick={() => Object.keys(c.options).length ? setType(k) : onAdd({ id: Math.random().toString(36).slice(2, 10), type: k, size: c.size, options: {} })}
              className="h-full w-full rounded-xl border border-border p-3 text-left enabled:hover:border-control enabled:hover:bg-raised disabled:opacity-55">
              <div className="text-sm font-medium">{c.label}</div>
              <div className="mt-0.5 text-xs text-muted">{c.available ? c.description : `Nécessite ${c.moduleName}`}</div>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Champs d'options d'un type de bloc : listes déroulantes pour les projets, indicateurs et sites. */
function WidgetForm({ type, catalog, initial, submit, onSubmit, onCancel }: {
  type: string; catalog: Catalog; initial?: Widget; submit: string; onSubmit: (p: Partial<Widget>) => void; onCancel: () => void;
}) {
  const { data: projects } = useData<Project[]>("/api/projects?days=1");
  const { data: sites } = useData<Site[]>("/api/sites");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [opts, setOpts] = useState<Record<string, string | number | boolean>>(initial?.options ?? {});
  const set = (k: string, v: string) => setOpts((o) => ({ ...o, [k]: v }));
  const field = (k: string, hint: string): ReactNode => {
    const v = String(opts[k] ?? "");
    const required = hint.includes("obligatoire");
    if (k === "project") return <select required={required} value={v} onChange={(e) => set(k, e.target.value)} className={inputCls}><option value="">{required ? "Choisir un projet" : "Tous les projets"}</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;
    if (k === "indicator") return <select required value={v} onChange={(e) => set(k, e.target.value)} className={inputCls}><option value="">Choisir un indicateur</option>{projects?.map((p) => <optgroup key={p.id} label={p.name}>{p.indicators.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</optgroup>)}</select>;
    if (k === "site") return <select required value={v} onChange={(e) => set(k, e.target.value)} className={inputCls}><option value="">Choisir un site</option>{sites?.map((s) => <option key={s.id} value={s.domain}>{s.domain}</option>)}</select>;
    if (k === "text") return <textarea required rows={8} value={v} onChange={(e) => set(k, e.target.value)} className={`${inputCls} h-auto py-2 font-mono text-xs`} placeholder={"# Titre\n- un point\n**important**"} />;
    return <input value={v} onChange={(e) => set(k, e.target.value)} className={inputCls} placeholder={hint} />;
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ title: title || undefined, options: Object.fromEntries(Object.entries(opts).filter(([, x]) => x !== "")) }); }}
      className="mt-2 space-y-3 rounded-xl border border-border bg-surface p-3 text-sm">
      <label className="block">Titre (facultatif)<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={catalog[type].label} className={`${inputCls} mt-1`} /></label>
      {Object.entries(catalog[type].options).map(([k, hint]) => <label key={k} className="block">{hint.replace(/ \(.*\)$/, "")}<div className="mt-1">{field(k, hint)}</div></label>)}
      <div className="flex gap-2"><Button>{submit}</Button><button type="button" onClick={onCancel} className="px-3 text-muted hover:text-ink">Annuler</button></div>
    </form>
  );
}

// ── Contenu de chaque type de bloc ──
function WidgetBody({ w, o, days, go }: { w: Widget; o: Portfolio; days: number; go: Go }) {
  const t = w.title, opt = w.options;
  switch (w.type) {
    case "pulse": return <Pulse t={o.totals} days={days} go={go} />;
    case "traffic_by_project": return <TrafficByProject o={o} title={t} />;
    case "todo": return <Todo alerts={o.alerts} go={go} title={t} />;
    case "projects_table": return <Matrix rows={o.projects} days={days} range={o.range} go={go} title={t} />;
    case "pipeline": return <PipelineCard go={go} title={t} />;
    case "publications": return <PubsCard go={go} title={t} />;
    case "project": return <ProjectWidget id={String(opt.project ?? "")} days={days} go={go} title={t} />;
    case "indicator": return <IndicatorWidget id={String(opt.indicator ?? "")} days={days} title={t} />;
    case "goals": return <GoalsWidget project={opt.project ? String(opt.project) : ""} title={t} />;
    case "site": return <SiteWidget domain={String(opt.site ?? "")} days={days} go={go} title={t} />;
    case "seo": return <SeoWidget domain={String(opt.site ?? "")} days={days} title={t} />;
    case "note": return <Card title={t}><Markdown text={String(opt.text ?? "")} /></Card>;
    case "agent_log": return <AgentLogWidget agent={opt.agent ? String(opt.agent) : ""} limit={Number(opt.limit) || 12} title={t} go={go} />;
    default: return <Card><EmptyBox>Bloc inconnu : {w.type}</EmptyBox></Card>;
  }
}

function ProjectWidget({ id, days, go, title }: { id: string; days: number; go: Go; title?: string }) {
  const { data: p, error } = useData<Project>(`/api/projects/${encodeURIComponent(id)}?days=${days}`);
  if (error) return <Card title={title}><EmptyBox>{error}</EmptyBox></Card>;
  if (!p) return <KpiSkeleton />;
  return (
    <Card title={<button onClick={() => go({ view: "project", id: p.id })} className="flex items-center gap-2.5 text-lg font-light hover:underline"><span className="size-2.5 rounded-full" style={{ background: p.color ?? "var(--color-accent)" }} />{title ?? p.name}</button>}>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {p.indicators.map((i) => <KpiCard key={i.id} label={i.label} value={val(i.value, i.unit)} delta={<Delta now={i.value} before={i.previous} />} hint={i.last_error ? `Erreur : ${i.last_error}` : undefined} />)}
      </div>
    </Card>
  );
}

function IndicatorWidget({ id, days, title }: { id: string; days: number; title?: string }) {
  const { data } = useData<Project[]>(`/api/projects?days=${days}`);
  if (!data) return <KpiSkeleton />;
  const p = data.find((x) => x.indicators.some((i) => i.id === id));
  const i = p?.indicators.find((x) => x.id === id);
  if (!p || !i) return <Card title={title}><EmptyBox>Indicateur introuvable : choisissez-en un dans « Réglages ».</EmptyBox></Card>;
  return (
    <Card title={title ?? `${p.name} · ${i.label}`} action={<span className="flex items-center gap-2"><span className="num text-lg font-light">{val(i.value, i.unit)}</span><Delta now={i.value} before={i.previous} /></span>}>
      {i.series.some((s) => s.value != null)
        ? <BarChart label={i.label} days={i.series.map((s) => s.day)} values={i.series.map((s) => s.value ?? 0)} color={p.color ?? undefined} height={220} />
        : <EmptyBox>{i.last_error ? `Le relevé a échoué : ${i.last_error}` : "Pas encore de données sur la période."}</EmptyBox>}
    </Card>
  );
}

function GoalsWidget({ project, title = "Objectifs" }: { project: string; title?: string }) {
  const { data } = useData<Project[]>("/api/projects?days=7");
  if (!data) return <KpiSkeleton />;
  const inds = data.filter((p) => !project || p.id === project || p.crm_key === project).flatMap((p) => p.indicators.filter((i) => i.goal).map((i) => ({ ...i, label: `${p.name} · ${i.label}` })));
  return <Card title={title}>{inds.length ? <div className="space-y-4">{inds.map((i) => <GoalBar key={i.id} ind={i} />)}</div> : <EmptyBox>Aucun objectif : fixez-en dans « Gérer le projet ».</EmptyBox>}</Card>;
}

function useSite(domain: string) {
  const { data: sites } = useData<Site[]>("/api/sites");
  return sites ? sites.find((s) => s.domain === domain) ?? null : undefined;
}

function SiteWidget({ domain, days, go, title }: { domain: string; days: number; go: Go; title?: string }) {
  const site = useSite(domain);
  if (site === undefined) return <KpiSkeleton />;
  if (!site) return <Card title={title}><EmptyBox>Site introuvable : {domain || "aucun choisi"}.</EmptyBox></Card>;
  return <SiteTraffic site={site} days={days} go={go} title={title} />;
}
function SiteTraffic({ site, days, go, title }: { site: Site; days: number; go: Go; title?: string }) {
  const { data: t } = useData<Traffic>(`/api/sites/${site.id}/traffic?days=${days}`);
  if (!t) return <KpiSkeleton />;
  const c = fillDays(t.daily, t.range.from, t.range.to, (d) => d.visitors);
  return (
    <Card title={<button onClick={() => go({ view: undefined, id: undefined, site: site.domain })} className="text-lg font-light hover:underline">{title ?? site.domain}</button>}
      action={<span className="flex items-center gap-2"><span className="num text-lg font-light">{fmt(t.totals.visitors)}</span><Delta now={t.totals.visitors} before={t.previous.visitors} /></span>}>
      <BarChart label={`Visiteurs de ${site.domain}`} days={c.days} values={c.values} height={200} />
      <p className="mt-3 text-xs text-muted">{t.channels.slice(0, 4).map((x) => `${x.key} ${fmt((x.visitors / Math.max(t.totals.visitors, 1)) * 100)} %`).join(" · ")}</p>
    </Card>
  );
}

function SeoWidget({ domain, days, title }: { domain: string; days: number; title?: string }) {
  const site = useSite(domain);
  const { data: s } = useData<Search>(site ? `/api/sites/${site.id}/search?days=${days}` : "/api/me");
  if (site === undefined || (site && !s)) return <KpiSkeleton />;
  if (!site) return <Card title={title}><EmptyBox>Site introuvable : {domain || "aucun choisi"}.</EmptyBox></Card>;
  return (
    <Card title={title ?? `Mots-clés à travailler · ${site.domain}`}>
      <Table rows={(s as Search).opportunities?.slice(0, 8) ?? []} empty="Aucun mot-clé entre la 4e et la 20e position." cols={[
        { label: "Mot-clé", className: "w-1/2", render: (r) => r.query },
        { label: "Impr.", num: true, render: (r) => fmt(r.impressions) },
        { label: "Position", num: true, render: (r) => fmt(r.position, 1) },
      ]} />
    </Card>
  );
}

function AgentLogWidget({ agent, limit, title = "Journal des agents", go }: { agent: string; limit: number; title?: string; go: Go }) {
  const { data } = useData<{ ts: number; agent: string; tool: string; args: string | null; ok: number; error: string | null }[]>(`/api/agents/log?limit=${Math.min(Math.max(limit, 5), 50)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`);
  return (
    <Card title={title} action={<Button variant="secondary" onClick={() => go({ view: "agents", id: undefined, site: undefined })}>Agents</Button>}>
      {!data ? null : data.length ? (
        <ul className="divide-y divide-rule text-sm">
          {data.map((r, k) => (
            <li key={k} className="flex min-h-10 items-center gap-3 py-1.5">
              <span className={`size-2 shrink-0 rounded-full ${r.ok ? "bg-positive" : "bg-negative"}`} aria-label={r.ok ? "Réussi" : "Échec"} />
              <span className="w-24 shrink-0 truncate font-medium">{r.agent}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.error ?? r.args ?? ""}>{r.tool}</span>
              <span className="num shrink-0 text-xs text-muted">{when(r.ts)}</span>
            </li>
          ))}
        </ul>
      ) : <EmptyBox>Aucun agent n'a encore appelé Searchtide.</EmptyBox>}
    </Card>
  );
}

/** Markdown minimal, sans HTML brut : titres, listes, gras, italique, code, liens http(s). */
export function Markdown({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, i) => {
    if (/^\*\*.+\*\*$/.test(part)) return <b key={i} className="font-medium">{part.slice(2, -2)}</b>;
    if (/^\*.+\*$/.test(part)) return <i key={i}>{part.slice(1, -1)}</i>;
    if (/^`.+`$/.test(part)) return <code key={i} className="rounded bg-raised px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
    const m = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (m) return <a key={i} href={m[2]} target="_blank" rel="noreferrer" className="underline">{m[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={blocks.length} className="list-disc space-y-1 pl-5">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; };
  for (const line of text.split("\n")) {
    const li = line.match(/^\s*[-*] (.*)/);
    if (li) { list.push(li[1]); continue; }
    flush();
    const h = line.match(/^(#{1,3}) (.*)/);
    if (h) blocks.push(<p key={blocks.length} className={h[1].length === 1 ? "text-lg font-light" : "font-medium"}>{inline(h[2])}</p>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-2 text-sm leading-6">{blocks.length ? blocks : <span className="text-muted">Note vide.</span>}</div>;
}
