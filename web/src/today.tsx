// À traiter : ce qui demande une action, d'abord l'urgent, puis ce qui peut attendre. Vue par projet ou par urgence.
import { api } from "./api";
import { Header, useData } from "./App";
import { target } from "./portfolio";
import { Card, EmptyBox, Pill, Segmented } from "./ui";

type Go = (n: Record<string, string | undefined>) => void;
export type TodayItem = { key: string; kind: "alerte" | "action" | "jalon" | "objectif"; tone: "bad" | "warn" | "info"; project_id: string | null; text: string; metric?: string; to: Record<string, string> };
type Project = { id: string; name: string; color: string | null };
const DOT = { bad: "bg-negative", warn: "bg-chart-3", info: "bg-chart-2" };
const KIND = { alerte: "Alerte", action: "Action", jalon: "Jalon", objectif: "Objectif" };
const TONE = { bad: "Panne", warn: "À surveiller", info: "À faire" } as const;

/** Source lisible, déduite de la destination de l'action. */
function source(i: TodayItem) {
  if (i.to.view === "agents") return "Approbations";
  if (i.to.view === "crm") return "Contacts";
  if (i.to.view === "pubs") return "Publications";
  if (i.to.view === "rdv") return "Rendez-vous";
  if (i.to.tab === "seo" || i.to.tab === "search") return "SEO";
  if (i.kind === "objectif") return "Objectif";
  if (i.kind === "jalon") return "Jalon";
  return "Projet";
}

function TodayList({ items, go, onChange, projects, compact = false }: { items: TodayItem[]; go: Go; onChange: () => void; projects: Project[]; compact?: boolean }) {
  const mark = async (key: string, state: "done" | "snoozed" | "ignored") => {
    await api(`/api/today/${encodeURIComponent(key)}`, { method: "POST", json: { state } });
    onChange();
    dispatchEvent(new Event("st-today-changed"));
  };
  return (
    <ul className={`-mx-2 divide-y divide-rule ${compact ? "max-h-[340px] overflow-y-auto" : ""}`}>
      {items.map((i) => {
        const p = projects.find((x) => x.id === i.project_id);
        return (
          <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 text-sm">
            <span className={`size-2 shrink-0 rounded-full ${DOT[i.tone]}`} aria-label={TONE[i.tone]} />
            {p && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: p.color ?? "var(--color-control)" }} />}
            <button onClick={() => go(target(i.to))} className="min-w-0 flex-1 text-left hover:underline">
              {i.text}{!compact && i.metric && <span className="ml-2 text-xs text-muted">fait monter : {i.metric}</span>}
            </button>
            {!compact && <span className="text-xs text-muted">{p?.name ?? source(i)} · {source(i)}</span>}
            {!compact && <Pill>{KIND[i.kind]}</Pill>}
            <span className="flex gap-2 text-xs">
              <button onClick={() => mark(i.key, "done")} className="text-muted hover:text-ink">Fait</button>
              <button onClick={() => mark(i.key, "snoozed")} className="text-muted hover:text-ink">Plus tard</button>
              <button onClick={() => mark(i.key, "ignored")} className="text-muted hover:text-ink">Ignorer</button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Bloc « À traiter » des pages : une vue du fil. */
export function TodayCard({ go, title = "À traiter" }: { go: Go; title?: string }) {
  const { data, reload } = useData<TodayItem[]>("/api/today");
  const { data: projects } = useData<Project[]>("/api/projects?days=1");
  return (
    <Card title={title} action={data?.length ? <span className="num text-sm text-muted">{data.length}</span> : null}>
      {data?.length ? <TodayList items={data} go={go} onChange={reload} projects={projects ?? []} compact /> : <p className="text-sm text-muted">Rien à traiter : aucun relevé en panne, aucune échéance proche.</p>}
    </Card>
  );
}

export function TodayView({ go, q = {}, banner }: { go: Go; q?: Record<string, string>; banner?: React.ReactNode }) {
  const { data, reload } = useData<TodayItem[]>("/api/today");
  const { data: projects } = useData<Project[]>("/api/projects?days=1");
  const tab = q.tab === "tous" ? "tous" : "aujourdhui";
  const project = q.project ?? "";
  const items = (data ?? []).filter((i) => !project || i.project_id === project);
  const urgent = items.filter((i) => i.tone !== "info");
  const later = items.filter((i) => i.tone === "info");
  const byProject = (projects ?? []).map((p) => ({ p, list: items.filter((i) => i.project_id === p.id) })).filter((x) => x.list.length);
  const orphans = items.filter((i) => !i.project_id || !projects?.some((p) => p.id === i.project_id));
  const list = (rows: TodayItem[]) => <TodayList items={rows} go={go} onChange={reload} projects={projects ?? []} />;

  return (
    <>
      <Header title="À traiter" sub="Ce qui demande une action : pannes, échéances, objectifs en retard et ce qui peut faire monter vos chiffres." />
      {banner}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Vues de À traiter" value={tab} onChange={(v) => go({ tab: v === "aujourdhui" ? undefined : v })} options={[["aujourdhui", "À traiter"], ["tous", "Tous les projets"]] as const} />
        <div role="group" aria-label="Filtrer par projet" className="no-scrollbar flex gap-2 overflow-x-auto">
          <button type="button" aria-pressed={!project} onClick={() => go({ project: undefined })} className={`h-9 shrink-0 rounded-full border px-3 text-sm ${!project ? "border-control bg-active text-ink" : "border-border text-muted hover:text-ink"}`}>Tous</button>
          {(projects ?? []).map((p) => (
            <button key={p.id} type="button" aria-pressed={project === p.id} onClick={() => go({ project: p.id })}
              className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm ${project === p.id ? "border-control bg-active text-ink" : "border-border text-muted hover:text-ink"}`}>
              <span aria-hidden className="size-2 rounded-full" style={{ background: p.color ?? "var(--color-control)" }} />{p.name}
            </button>
          ))}
        </div>
      </div>
      {!data ? <Card><EmptyBox>Chargement…</EmptyBox></Card> : !items.length ? <Card><EmptyBox>{project ? "Rien à traiter pour ce projet." : "Rien à traiter aujourd'hui."}</EmptyBox></Card> : tab === "tous" ? (
        <div className="space-y-4">
          {byProject.map(({ p, list: rows }) => <Card key={p.id} title={p.name}>{list(rows)}</Card>)}
          {orphans.length > 0 && <Card title="Sans projet">{list(orphans)}</Card>}
        </div>
      ) : (
        <div className="space-y-4">
          {urgent.length > 0 && <Card title="À faire maintenant">{list(urgent)}</Card>}
          {later.length > 0 && <Card title="Peut attendre">{list(later)}</Card>}
        </div>
      )}
    </>
  );
}
