// Projets : cartes de la vue d'ensemble, page d'un projet (indicateurs, sites, contacts, publications), gestion des indicateurs.
import { useEffect, useState, type FormEvent } from "react";
import { api, type Overview as OverviewData, type Site } from "./api";
import { ErrorLine, Header, KpiSkeleton, useData } from "./App";
import { STAGES } from "./modules/shared";
import { BarChart } from "./chart";
import { SourcesCard } from "./sources";
import { ProjectTabBar, ProjectTabBody } from "./projects/ProjectTabs";
import { useCatalog } from "./connections";
import { Button, Card, Delta, EmptyBox, KpiCard, Pill, Table, fmt, inputCls } from "./ui";

type Point = { day: string; value: number | null };
export type Indicator = {
  id: string; label: string; unit: string | null; mode: "daily" | "total"; source: string; config: Record<string, any>;
  last_run: number | null; last_error: string | null; value: number | null; previous: number | null; series: Point[];
  goal: { target: number; period: "week" | "month"; done: number; projection: number; pct: number; elapsed: number; total: number } | null;
};
export type Project = {
  id: string; name: string; color: string | null; url: string | null; sites: string[]; crm_key: string | null; indicators: Indicator[];
  funnel: { id: string; label: string; value: number | null; rate: number | null }[]; pinned?: boolean;
};
type Go = (n: Record<string, string | undefined>) => void;

const SOURCES = [["pg", "Base de données (Postgres)"], ["supabase", "Supabase"], ["stripe", "Stripe"], ["site", "Site suivi"], ["pagespeed", "PageSpeed (vitesse du site)"], ["play", "Google Play"], ["http", "Adresse web (JSON)"], ["manual", "Saisie à la main"]] as const;
/** Connecteur qui fournit chaque source d'indicateur. */
const KIND: Record<string, string> = { stripe: "stripe", pg: "postgres", supabase: "supabase", http: "jsonapi", pagespeed: "pagespeed", play: "google" };
const PSI_METRICS = [["performance", "Performance (sur 100)"], ["seo", "SEO technique (sur 100)"], ["lcp", "Affichage du contenu principal (LCP, s)"], ["cls", "Stabilité de la mise en page (CLS)"]] as const;
const PLAY_METRICS = [["daily_installs", "Installations par jour"], ["active_installs", "Appareils actifs"], ["rating", "Note moyenne"]] as const;
const STRIPE_METRICS = [["revenue", "Chiffre d'affaires (par jour)"], ["new_customers", "Nouveaux clients (par jour)"], ["active_subscriptions", "Abonnements actifs"], ["mrr", "Revenu mensuel récurrent"]] as const;
const SITE_METRICS = [["visitors", "Visiteurs"], ["pageviews", "Pages vues"], ["clicks", "Clics Google"], ["impressions", "Impressions Google"]] as const;
export const val = (v: number | null, unit: string | null) => v == null ? "—" : unit === "€" ? `${fmt(v, Math.abs(v) < 100 && v % 1 ? 2 : 0)} €` : `${fmt(v, v % 1 ? 1 : 0)}${unit ? ` ${unit}` : ""}`;

export function Sparkline({ points, color = "var(--color-accent)" }: { points: Point[]; color?: string }) {
  const vals = points.map((p) => p.value ?? 0);
  const max = Math.max(...vals, 1), w = 120, h = 32;
  const d = vals.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(vals.length - 1, 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join("");
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full" preserveAspectRatio="none" aria-hidden><path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

// ── Cartes des projets (vue d'ensemble) ──
export function ProjectCards({ days, go }: { days: number; go: Go }) {
  const { data } = useData<Project[]>(`/api/projects?days=${days}`);
  if (!data?.length) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {data.map((p) => (
        <button key={p.id} onClick={() => go({ view: "project", id: p.id, site: undefined })}
          className="min-w-0 rounded-2xl border border-border bg-surface p-5 text-left transition-colors hover:border-control">
          <div className="flex items-center gap-2.5"><span className="size-2.5 rounded-full" style={{ background: p.color ?? "var(--color-accent)" }} aria-hidden /><span className="text-lg font-light">{p.name}</span></div>
          {p.indicators.length ? (
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
              {p.indicators.slice(0, 4).map((i) => (
                <div key={i.id} className="min-w-0">
                  <div className="truncate text-xs text-muted" title={i.last_error ?? undefined}>{i.label}{i.last_error && <span className="text-negative"> · erreur</span>}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2"><span className="num text-xl font-light">{val(i.value, i.unit)}</span><Delta now={i.value} before={i.previous} /></div>
                  {i.mode === "daily" && <Sparkline points={i.series} color={p.color ?? undefined} />}
                </div>
              ))}
            </div>
          ) : <p className="mt-3 text-sm text-muted">Aucun indicateur : ouvrez le projet pour en ajouter.</p>}
        </button>
      ))}
    </div>
  );
}

// ── Page d'un projet ──
export function ProjectView({ id, days, go, tab = "vue", me = { gsc: false, demo: false }, onPinned }: { id: string; days: number; go: Go; tab?: string; me?: { gsc: boolean; demo: boolean }; onPinned?: () => void }) {
  const { data: p, error, reload } = useData<Project>(`/api/projects/${id}?days=${days}`);
  const [selected, setSelected] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const { data: notes, reload: reloadNotes } = useData<{ id: string; day: string; label: string; kind: string }[]>(`/api/annotations?project=${id}&days=${days}`);
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!p) return <KpiSkeleton />;
  const goals = p.indicators.filter((i) => i.goal);
  const current = p.indicators.find((i) => i.id === selected) ?? p.indicators.find((i) => i.mode === "daily") ?? p.indicators[0];
  return (
    <>
      <Header title={<span className="flex items-center gap-3"><span className="size-3 rounded-full" style={{ background: p.color ?? "var(--color-accent)" }} aria-hidden />{p.name}</span>}
        sub={p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-ink">{p.url.replace(/^https?:\/\//, "")} ↗</a> : undefined} days={days} go={go}>
        <Button variant="secondary" aria-pressed={!!p.pinned} onClick={async () => { await api(`/api/projects/${p.id}`, { method: "PATCH", json: { pinned: !p.pinned } }); reload(); onPinned?.(); }}>
          {p.pinned ? "★ Épinglé" : "☆ Épingler"}
        </Button>
        <Button variant="secondary" onClick={() => setManage(true)}>Gérer le projet</Button>
      </Header>
      <ProjectTabBar project={p} tab={tab} go={go} />
      {tab !== "vue" ? <ProjectTabBody project={p} tab={tab} days={days} go={go} me={me} onChanged={reload} /> :
      <div className="space-y-4">
        {p.indicators.length ? (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {p.indicators.map((i) => (
                <KpiCard key={i.id} label={i.label} value={val(i.value, i.unit)} delta={<Delta now={i.value} before={i.previous} />}
                  active={current?.id === i.id} onClick={() => setSelected(i.id)}
                  hint={i.last_error ? `Erreur : ${i.last_error}` : i.goal ? `Objectif : ${fmt(i.goal.pct)} % (${i.goal.period === "week" ? "semaine" : "mois"})` : i.mode === "total" ? "Niveau actuel" : `Total sur ${days} jours`} />
              ))}
            </div>
            {current && (
              <Card title={current.label} action={current.source === "manual" ? <ManualEntry ind={current} onSaved={reload} /> : current.last_run ? <span className="text-xs text-muted">Relevé le {new Date(current.last_run).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span> : null}>
                {current.series.some((s) => s.value != null)
                  ? <BarChart label={current.label} days={current.series.map((s) => s.day)} values={current.series.map((s) => s.value ?? 0)} markers={notes ?? []} color={p.color ?? undefined} />
                  : <EmptyBox>{current.last_error ? `Le relevé a échoué : ${current.last_error}` : current.source === "manual" ? "Aucune valeur saisie sur la période." : "Pas encore de données sur la période."}</EmptyBox>}
              </Card>
            )}
            <Milestones projectId={p.id} key={notes?.length ?? 0} />
            <AddNote projectId={p.id} onAdded={reloadNotes} count={notes?.length ?? 0} />
          </>
        ) : <EmptyBox>Aucun indicateur. <button onClick={() => setManage(true)} className="text-ink underline">Ajouter le premier</button></EmptyBox>}
        {(goals.length > 0 || p.funnel.length > 1) && (
          <div className="grid gap-4 lg:grid-cols-2">
            {goals.length > 0 && <Card title="Objectifs"><div className="space-y-4">{goals.map((i) => <GoalBar key={i.id} ind={i} />)}</div></Card>}
            {p.funnel.length > 1 && <Funnel steps={p.funnel} days={days} />}
          </div>
        )}
        <SourcesCard projectId={p.id} onChanged={reload} go={go} />
        <div className="grid gap-4 lg:grid-cols-2">
          <ProjectSites project={p} days={days} go={go} />
          <ProjectCrm project={p} go={go} />
        </div>
      </div>}
      {manage && <ManageProject project={p} onClose={() => setManage(false)} onSaved={reload} onDeleted={() => go({ view: undefined, id: undefined })} />}
    </>
  );
}

export function GoalBar({ ind }: { ind: Indicator }) {
  const g = ind.goal!;
  const onTrack = g.projection >= g.target;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{ind.label} <span className="text-muted">· {g.period === "week" ? "cette semaine" : "ce mois-ci"}</span></span>
        <span className="num">{val(g.done, ind.unit)} / {val(g.target, ind.unit)}</span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={Math.min(g.pct, 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${ind.label} : ${g.pct} % de l'objectif`}>
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(g.pct, 100)}%` }} />
      </div>
      <p className={`mt-1.5 text-xs ${onTrack ? "text-positive" : "text-muted"}`}>
        {ind.mode === "daily" ? `Au rythme actuel : ${val(g.projection, ind.unit)} en fin de ${g.period === "week" ? "semaine" : "mois"} (${onTrack ? "objectif atteint" : `il manque ${val(Math.max(g.target - g.projection, 0), ind.unit)}`}) · jour ${g.elapsed} sur ${g.total}` : `${fmt(g.pct, 1)} % de l'objectif`}
      </p>
    </div>
  );
}

function Funnel({ steps, days }: { steps: Project["funnel"]; days: number }) {
  const max = Math.max(...steps.map((s) => s.value ?? 0), 1);
  return (
    <Card title="Entonnoir" action={<span className="text-xs text-muted">Sur {days} jours</span>}>
      <ol className="space-y-3">
        {steps.map((s, k) => (
          <li key={s.id}>
            {k > 0 && <div className="mb-1 pl-1 text-xs text-muted">↓ {s.rate != null ? `${fmt(s.rate, 1)} % passent à l'étape suivante` : "taux inconnu"}</div>}
            <div className="flex items-center gap-3">
              <div className="h-9 rounded-xl bg-active" style={{ width: `${Math.max(((s.value ?? 0) / max) * 100, 6)}%` }} />
              <span className="shrink-0 text-sm">{s.label}</span>
              <span className="num ml-auto shrink-0 text-sm">{fmt(s.value)}</span>
            </div>
          </li>
        ))}
      </ol>
      {steps.length > 1 && steps[0].value ? <p className="mt-4 text-sm">Conversion globale : <b className="num">{fmt(((steps.at(-1)!.value ?? 0) / steps[0].value) * 100, 2)} %</b></p> : null}
    </Card>
  );
}

/** Jalons des 30 prochains jours avec le nombre de jours restants. */
function Milestones({ projectId }: { projectId: string }) {
  const { data } = useData<{ id: string; day: string; label: string; daysLeft: number }[]>(`/api/milestones?project=${projectId}&days=30`);
  if (!data?.length) return null;
  return (
    <ul aria-label="Jalons à venir" className="flex flex-wrap gap-2">
      {data.map((m) => (
        <li key={m.id} className={`rounded-full border px-3 py-1 text-sm ${m.daysLeft <= 7 ? "border-accent" : "border-border"}`}>
          <span className="num font-medium">{m.daysLeft === 0 ? "Aujourd'hui" : `J-${m.daysLeft}`}</span> · {m.label}
          <span className="ml-1.5 text-xs text-muted">{new Date(m.day).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span>
        </li>
      ))}
    </ul>
  );
}

function AddNote({ projectId, onAdded, count }: { projectId: string; onAdded: () => void; count: number }) {
  const [open, setOpen] = useState(false);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    await api("/api/annotations", { method: "POST", json: { ...f, milestone: f.milestone === "on", project_id: projectId } });
    setOpen(false); onAdded();
  }
  return open ? (
    <form onSubmit={add} className="flex flex-wrap items-center gap-2 text-sm">
      <input name="day" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} className={`${inputCls.replace("h-10 w-full", "h-9")} w-40`} aria-label="Date" />
      <input name="label" required placeholder="Ex. lancement de la version 2" className={`${inputCls.replace("h-10 w-full", "h-9")} min-w-0 flex-1`} aria-label="Repère" />
      <label className="flex items-center gap-1.5 text-muted"><input type="checkbox" name="milestone" className="size-4" />Jalon (compte à rebours)</label>
      <Button variant="secondary">Ajouter</Button>
      <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-ink">Annuler</button>
    </form>
  ) : (
    <p className="text-xs text-muted">
      <span className="mr-1.5 inline-block size-2 rounded-full bg-chart-2 align-middle" aria-hidden />{count ? `${count} repère${count > 1 ? "s" : ""} sur la courbe (publications et notes)` : "Les publications et vos notes apparaissent comme repères sous la courbe."}{" "}
      <button onClick={() => setOpen(true)} className="text-ink underline">Ajouter un repère</button>
    </p>
  );
}

function ManualEntry({ ind, onSaved }: { ind: Indicator; onSaved: () => void }) {
  const [v, setV] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    await api(`/api/indicators/${ind.id}/value`, { method: "POST", json: { value: Number(v.replace(",", ".")) } });
    setV(""); onSaved();
  }
  return (
    <form onSubmit={save} className="flex items-center gap-2">
      <input aria-label="Valeur du jour" value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" placeholder="Valeur du jour" className={`${inputCls.replace("h-10 w-full", "h-9")} w-36`} required />
      <Button variant="secondary">Enregistrer</Button>
    </form>
  );
}

function ProjectSites({ project, days, go }: { project: Project; days: number; go: Go }) {
  const { data } = useData<OverviewData>(`/api/overview?days=${days}`);
  const rows = data?.sites.filter((s) => project.sites.includes(s.domain)) ?? [];
  return (
    <Card title="Sites">
      <Table rows={rows} onRow={(s) => go({ view: undefined, id: undefined, site: s.domain })} empty="Aucun site rattaché : choisissez-les dans « Gérer le projet »." cols={[
        { label: "Site", className: "w-1/3", render: (s) => s.domain },
        { label: "Visiteurs", num: true, render: (s) => fmt(s.traffic.visitors) },
        { label: "Évolution", num: true, render: (s) => <Delta now={s.traffic.visitors} before={s.trafficPrev.visitors} /> },
        { label: "Clics Google", num: true, render: (s) => s.search ? fmt(s.search.clicks) : "—" },
      ]} />
    </Card>
  );
}

function ProjectCrm({ project, go }: { project: Project; go: Go }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [pubs, setPubs] = useState<{ id: string; day: string; title: string; status: string; network: string | null }[] | null>(null);
  useEffect(() => {
    if (!project.crm_key) return;
    const k = encodeURIComponent(project.crm_key);
    Promise.all(STAGES.map(([st]) => api<{ total: number }>(`/api/contacts?project=${k}&stage=${st}&limit=1`).then((r) => [st, r.total] as const))).then((r) => setCounts(Object.fromEntries(r)));
    const t = new Date().toISOString().slice(0, 10), end = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    api<typeof pubs>(`/api/publications?project=${k}&from=${t}&to=${end}`).then(setPubs);
  }, [project.crm_key]);
  if (!project.crm_key) return <Card title="Contacts et publications"><EmptyBox>Indiquez la clé de projet (ex. « monprojet ») dans « Gérer le projet » pour relier ses contacts et publications.</EmptyBox></Card>;
  return (
    <Card title="Contacts et publications" action={<Button variant="secondary" onClick={() => go({ view: "crm", id: undefined, project: project.crm_key! })}>Ouvrir les contacts</Button>}>
      <div className="grid grid-cols-3 gap-3">
        {STAGES.map(([st, label]) => <div key={st}><div className="text-xs text-muted">{label}</div><div className="num text-xl font-light">{counts ? fmt(counts[st]) : "—"}</div></div>)}
      </div>
      <div className="mt-5 text-xs text-muted">Publications des 14 prochains jours</div>
      {pubs?.length ? <ul className="mt-1 divide-y divide-rule">{pubs.map((x) => <li key={x.id} className="flex h-10 items-center gap-3 text-sm"><span className="num w-16 shrink-0 text-muted">{new Date(x.day + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" })}</span><span className="min-w-0 flex-1 truncate">{x.title}</span>{x.network && <Pill>{x.network}</Pill>}</li>)}</ul>
        : <p className="mt-1 text-sm text-muted">Rien de prévu.</p>}
    </Card>
  );
}

// ── Gestion : projet et indicateurs ──
function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`block text-sm ${className}`}><span className="text-muted">{label}</span><div className="mt-1.5">{children}</div></label>;
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", f); return () => removeEventListener("keydown", f); }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
      <div role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-3xl flex-col overflow-y-auto border-l border-border bg-ground">
        <div className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-border bg-ground px-5">
          <h2 className="truncate text-lg font-light">{title}</h2>
          <button onClick={onClose} className="h-11 px-2 text-sm text-muted hover:text-ink">Fermer</button>
        </div>
        <div className="space-y-4 p-5">{children}</div>
      </div>
    </div>
  );
}

export function ManageProject({ project, onClose, onSaved, onDeleted }: { project: Project | null; onClose: () => void; onSaved: (p?: Project) => void; onDeleted?: () => void }) {
  const { data: sites } = useData<Site[]>("/api/sites");
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Partial<Indicator> | null>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = { name: f.get("name"), color: f.get("color"), url: f.get("url"), crm_key: f.get("crm_key"), sites: f.getAll("sites"),
      funnel: [...new Set(f.getAll("funnel").filter(Boolean))] };
    try {
      const p = await api<Project>(project ? `/api/projects/${project.id}` : "/api/projects", { method: project ? "PATCH" : "POST", json: body });
      setError(""); onSaved(p); // nouveau projet : le parent ouvre sa page
    } catch (err) { setError((err as Error).message); }
  }
  async function remove() {
    if (!project || !confirm(`Supprimer le projet ${project.name} et l'historique de ses indicateurs ? Les sites et contacts sont conservés.`)) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" }); onClose(); onDeleted?.();
  }
  async function removeInd(i: Indicator) {
    if (!confirm(`Supprimer l'indicateur « ${i.label} » et son historique ?`)) return;
    await api(`/api/indicators/${i.id}`, { method: "DELETE" }); onSaved();
  }
  return (
    <Panel title={project ? `Gérer ${project.name}` : "Nouveau projet"} onClose={onClose}>
      <form onSubmit={save} className="rounded-2xl border border-border bg-surface p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom *"><input name="name" required defaultValue={project?.name} className={inputCls} autoFocus={!project} /></Field>
          <Field label="Couleur"><input name="color" type="color" defaultValue={project?.color ?? "#c8f55a"} className={`${inputCls} p-1`} /></Field>
          <Field label="Adresse du produit"><input name="url" type="url" defaultValue={project?.url ?? ""} className={inputCls} placeholder="https://…" /></Field>
          <Field label="Clé des contacts et publications"><input name="crm_key" defaultValue={project?.crm_key ?? ""} className={inputCls} placeholder="ex. monprojet" /></Field>
        </div>
        <fieldset className="mt-4"><legend className="text-sm text-muted">Sites rattachés</legend>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {sites?.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="sites" value={s.domain} defaultChecked={project?.sites.includes(s.domain)} className="size-4 accent-[var(--color-accent)]" />{s.domain}</label>)}
          </div>
        </fieldset>
        {project && project.indicators.length > 1 && (
          <fieldset className="mt-4"><legend className="text-sm text-muted">Entonnoir de conversion (dans l'ordre, ex. visites → comptes → clients)</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {[0, 1, 2, 3, 4].map((k) => (
                <select key={k} name="funnel" aria-label={`Étape ${k + 1}`} defaultValue={project.funnel[k]?.id ?? ""} className={inputCls}>
                  <option value="">Étape {k + 1} : aucune</option>
                  {project.indicators.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                </select>
              ))}
            </div>
          </fieldset>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
        <div className="mt-5 flex items-center justify-between"><Button>{project ? "Enregistrer" : "Créer le projet"}</Button>{project && <button type="button" onClick={remove} className="text-sm text-negative hover:underline">Supprimer le projet</button>}</div>
      </form>
      {project && (
        <Card title="Indicateurs" action={<Button onClick={() => setEdit({ mode: "daily", source: "pg", config: {} })}>Ajouter</Button>}>
          {project.indicators.length ? (
            <ul className="divide-y divide-rule">
              {project.indicators.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-3 text-sm">
                  <span className="min-w-0 flex-1"><span className="block truncate">{i.label}</span><span className="block truncate text-xs text-muted">{SOURCES.find(([k]) => k === i.source)?.[1]} · {i.mode === "daily" ? "par jour" : "niveau"}{i.last_error ? <span className="text-negative"> · {i.last_error}</span> : ""}</span></span>
                  <button onClick={() => setEdit(i)} className="text-muted hover:text-ink">Modifier</button>
                  <button onClick={() => removeInd(i)} className="text-negative hover:underline">Supprimer</button>
                </li>
              ))}
            </ul>
          ) : <EmptyBox>Aucun indicateur pour l'instant.</EmptyBox>}
        </Card>
      )}
      {edit && project && <IndicatorForm projectId={project.id} ind={edit} sites={sites ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onSaved(); }} />}
    </Panel>
  );
}

function IndicatorForm({ projectId, ind, sites, onClose, onSaved }: { projectId: string; ind: Partial<Indicator>; sites: Site[]; onClose: () => void; onSaved: () => void }) {
  const [source, setSource] = useState(ind.source ?? "pg");
  const [test, setTest] = useState("");
  const [error, setError] = useState("");
  const { catalog } = useCatalog();
  const kind = KIND[source];
  const conns = catalog?.connectors.find((c) => c.id === kind)?.connections ?? [];
  const firstConn = (src: string) => catalog?.connectors.find((c) => c.id === KIND[src])?.connections[0]?.id ?? "";
  // "" : aucune connexion · "__env" : variable d'environnement (avancé, saisie explicite) · sinon l'id d'une connexion
  const [connId, setConnId] = useState<string>(ind.config?.connection_id ?? (ind.config?.env ? "__env" : ""));
  const [touched, setTouched] = useState(!!ind.config?.connection_id || !!ind.config?.env);
  useEffect(() => { if (!touched && kind && conns.length) setConnId(conns[0].id); }, [touched, kind, conns.length]); // première connexion proposée tant qu'on n'a rien choisi
  const useEnv = !!kind && connId === "__env";
  const useConn = !!kind && !!connId && connId !== "__env";
  const read = (form: HTMLFormElement) => {
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    // Aucune variable n'est préremplie : `env` n'est envoyé que s'il est saisi explicitement (CA20, E3)
    const link = { ...(useConn ? { connection_id: connId } : {}), ...(useEnv && f.env?.trim() ? { env: f.env.trim() } : {}) };
    const config = source === "pg" ? { sql: f.sql, ...link } : source === "stripe" ? { metric: f.metric, ...(useEnv && f.account ? { account: f.account } : {}), ...link }
      : source === "http" ? { url: f.url, path: f.path, ...link } : source === "site" ? { domain: f.domain, metric: f.metric }
      : source === "pagespeed" ? { url: f.url, metric: f.metric, strategy: f.strategy, ...link }
      : source === "play" ? { package: f.package, metric: f.metric, ...link }
      : source === "supabase" ? { metric: f.metric, ...(f.days ? { days: Number(f.days) } : {}), ...link }
      : source === "manual" ? { ...(f.role ? { role: f.role } : {}) } : {};
    return { label: f.label, unit: f.unit, mode: f.mode, source, config, goal: f.goal ? Number(f.goal.replace(",", ".")) : null, goal_period: f.goal_period };
  };
  async function runTest(form: HTMLFormElement) {
    setTest("Essai…");
    try { const r = await api<{ value: number }>("/api/indicators/test", { method: "POST", json: read(form) }); setTest(`Valeur aujourd'hui : ${fmt(r.value, 2)}`); }
    catch (e) { setTest(`Erreur : ${(e as Error).message}`); }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api(ind.id ? `/api/indicators/${ind.id}` : `/api/projects/${projectId}/indicators`, { method: ind.id ? "PATCH" : "POST", json: read(e.currentTarget) }); onSaved(); }
    catch (err) { setError((err as Error).message); }
  }
  const c = ind.config ?? {};
  return (
    <form onSubmit={save} className="space-y-4 rounded-2xl border border-accent bg-surface p-5">
      <div className="flex items-center justify-between"><h3 className="text-lg font-light">{ind.id ? "Modifier l'indicateur" : "Nouvel indicateur"}</h3><button type="button" onClick={onClose} className="text-sm text-muted hover:text-ink">Annuler</button></div>
      {!ind.id && (
        <p className="rounded-xl bg-raised px-3 py-2.5 text-xs leading-5 text-muted">
          Vous voulez suivre un chiffre qui existe déjà ailleurs ? Choisissez sa source, puis <strong className="font-medium text-ink">Tester</strong> avant
          d'enregistrer : Searchtide affiche la valeur d'aujourd'hui sans rien écrire. Si le test échoue, c'est la connexion ou l'accès qui manque, jamais le projet.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Nom *" className="sm:col-span-2"><input name="label" required defaultValue={ind.label} className={inputCls} placeholder="Inscriptions, chiffre d'affaires…" /></Field>
        <Field label="Unité"><input name="unit" defaultValue={ind.unit ?? ""} className={inputCls} placeholder="€, %…" /></Field>
        <Field label="Source">
          <select value={source} onChange={(e) => { setSource(e.target.value); setTouched(false); setConnId(firstConn(e.target.value)); }} className={inputCls}>{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </Field>
        <Field label="Type" className="sm:col-span-2">
          <select name="mode" defaultValue={ind.mode} className={inputCls}>
            <option value="daily">Chiffre par jour, additionné sur la période (inscriptions, ventes)</option>
            <option value="total">Niveau, dernière valeur (clients actifs, abonnés)</option>
          </select>
        </Field>
      </div>
      {kind && (
        <div className="space-y-3">
          <Field label={`Connexion${source === "http" ? " (facultative)" : " *"}`}>
            <select name="connexion" value={connId} onChange={(e) => { setConnId(e.target.value); setTouched(true); }} className={inputCls}>
              {source === "http" ? <option value="">Aucune : adresse ouverte, sans jeton</option> : !conns.length && <option value="">Aucune connexion</option>}
              {conns.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.hint}</option>)}
              <option value="__env">Variable d'environnement (avancé)</option>
            </select>
          </Field>
          {!conns.length && !useEnv && source !== "http" && <p className="text-xs text-muted">Aucune connexion {catalog?.connectors.find((c) => c.id === kind)?.name ?? ""} : <a href="?view=connections" className="text-accent underline">ajoutez-la dans Connexions</a>, puis revenez ici.</p>}
          {ind.id && ind.config?.env && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="rounded bg-raised px-1.5 py-0.5">via .env</span>
              {conns.length > 0 && !useConn && <button type="button" onClick={() => { setConnId(conns[0].id); setTouched(true); }} className="text-accent underline">Passer sur une connexion</button>}
            </p>
          )}
          {useEnv && (
            <Field label={source === "http" ? "Variable d'environnement du jeton (facultatif)" : source === "pagespeed" || source === "play" ? "Variable d'environnement (facultatif)" : "Variable d'environnement *"}>
              <input name="env" required={source === "pg" || source === "stripe"} defaultValue={ind.config?.env ?? ""} className={`${inputCls} font-mono`} placeholder="NOM_DE_LA_VARIABLE" />
            </Field>
          )}
        </div>
      )}
      {source === "pg" && (
        <Field label="Requête SQL (lecture seule) *">
          <textarea name="sql" required rows={4} defaultValue={c.sql ?? ""} className={`${inputCls} h-auto py-2 font-mono text-xs`} placeholder={"SELECT count(*) FROM dossiers WHERE created_at::date = $1"} />
          <span className="mt-1.5 block text-xs text-muted">Avec <code className="font-mono">$1</code> (le jour, AAAA-MM-JJ) : un chiffre par jour, avec 90 jours d'historique repris. Sans : un niveau relevé chaque jour.</span>
        </Field>
      )}
      {source === "stripe" && useEnv && <Field label="Compte Stripe (avec une clé d'organisation)"><input name="account" defaultValue={c.account ?? ""} pattern="acct_[A-Za-z0-9]+" placeholder="acct_…" className={`${inputCls} font-mono`} /></Field>}
      {source === "stripe" && <Field label="Mesure"><select name="metric" defaultValue={c.metric} className={inputCls}>{STRIPE_METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
      {source === "http" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Adresse *"><input name="url" type="url" required defaultValue={c.url ?? ""} className={inputCls} /></Field>
          <Field label="Chemin du nombre dans la réponse"><input name="path" defaultValue={c.path ?? ""} className={`${inputCls} font-mono`} placeholder="data.total" /></Field>
        </div>
      )}
      {source === "site" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Site"><select name="domain" defaultValue={c.domain} className={inputCls}>{sites.map((s) => <option key={s.id} value={s.domain}>{s.domain}</option>)}</select></Field>
          <Field label="Mesure"><select name="metric" defaultValue={c.metric} className={inputCls}>{SITE_METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
      )}
      {source === "pagespeed" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Page à mesurer *"><input name="url" type="url" required defaultValue={c.url ?? ""} className={inputCls} placeholder="https://…" /></Field>
          <Field label="Mesure"><select name="metric" defaultValue={c.metric} className={inputCls}>{PSI_METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Appareil"><select name="strategy" defaultValue={c.strategy ?? "mobile"} className={inputCls}><option value="mobile">Mobile</option><option value="desktop">Ordinateur</option></select></Field>
        </div>
      )}
      {source === "play" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom du paquet *"><input name="package" required defaultValue={c.package ?? ""} className={`${inputCls} font-mono`} placeholder="com.exemple.app" /></Field>
          <Field label="Mesure"><select name="metric" defaultValue={c.metric} className={inputCls}>{PLAY_METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
      )}
      {source === "play" && (
        <p className="text-xs leading-5 text-muted">
          Le compte de service Google de la connexion est utilisé ; le bucket des rapports Play se règle dans cette connexion (Connexions → Google).
        </p>
      )}
      {source === "supabase" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mesure"><select name="metric" defaultValue={c.metric ?? "users_total"} className={inputCls}>
            <option value="users_total">Utilisateurs (total)</option><option value="signups_on">Inscriptions par jour</option>
            <option value="signed_in">Connectés récemment</option><option value="db_size_bytes">Taille de la base</option>
          </select></Field>
          {c.metric === "signed_in" || !c.metric ? <Field label="Fenêtre (jours)"><input name="days" type="number" min="1" max="365" defaultValue={c.days ?? 7} className={inputCls} /></Field> : null}
        </div>
      )}
      {source === "manual" && (
        <>
          <Field label="Rôle dans le Portefeuille">
            <select name="role" defaultValue={c.role ?? ""} className={inputCls}>
              <option value="">Aucun</option>
              <option value="revenue">Chiffre d'affaires</option>
              <option value="contacts">Nouveaux contacts</option>
            </select>
          </Field>
          <p className="text-sm text-muted">La valeur se saisit sur la page du projet, ou par un agent avec l'outil indicator_record.</p>
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Objectif (facultatif)"><input name="goal" inputMode="decimal" defaultValue={ind.goal?.target ?? ""} className={inputCls} placeholder="Ex. 20" /></Field>
        <Field label="Période de l'objectif"><select name="goal_period" defaultValue={ind.goal?.period ?? "month"} className={inputCls}><option value="month">Par mois</option><option value="week">Par semaine</option></select></Field>
      </div>
      {test && <p role="status" className={`text-sm ${test.startsWith("Erreur") ? "text-negative" : ""}`}>{test}</p>}
      {error && <p role="alert" className="text-sm text-negative">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button>{ind.id ? "Enregistrer" : "Ajouter l'indicateur"}</Button>
        {source !== "manual" && <Button type="button" variant="secondary" onClick={(e) => runTest(e.currentTarget.form!)}>Tester</Button>}
      </div>
    </form>
  );
}
