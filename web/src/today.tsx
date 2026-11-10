// Fil « Aujourd'hui » : alertes, actions proposées par les modules, jalons proches et objectifs en retard. Fait, Plus tard, Ignorer.
import { api } from "./api";
import { Header, useData } from "./App";
import { target } from "./portfolio";
import { Card, EmptyBox, Pill } from "./ui";

type Go = (n: Record<string, string | undefined>) => void;
export type TodayItem = { key: string; kind: "alerte" | "action" | "jalon" | "objectif"; tone: "bad" | "warn" | "info"; project_id: string | null; text: string; metric?: string; to: Record<string, string> };
const DOT = { bad: "bg-negative", warn: "bg-chart-3", info: "bg-chart-2" };
const KIND = { alerte: "Alerte", action: "Action", jalon: "Jalon", objectif: "Objectif" };

function TodayList({ items, go, onChange, compact = false }: { items: TodayItem[]; go: Go; onChange: () => void; compact?: boolean }) {
  const mark = async (key: string, state: "done" | "snoozed" | "ignored") => { await api(`/api/today/${encodeURIComponent(key)}`, { method: "POST", json: { state } }); onChange(); };
  return (
    <ul className={`-mx-2 divide-y divide-rule ${compact ? "max-h-[340px] overflow-y-auto" : ""}`}>
      {items.map((i) => (
        <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 text-sm">
          <span className={`size-2 shrink-0 rounded-full ${DOT[i.tone]}`} aria-label={i.tone === "bad" ? "Panne" : i.tone === "warn" ? "À surveiller" : "À faire"} />
          <button onClick={() => go(target(i.to))} className="min-w-0 flex-1 text-left hover:underline">
            {i.text}{!compact && i.metric && <span className="ml-2 text-xs text-muted">fait monter : {i.metric}</span>}
          </button>
          {!compact && <Pill>{KIND[i.kind]}</Pill>}
          <span className="flex gap-2 text-xs">
            <button onClick={() => mark(i.key, "done")} className="text-muted hover:text-ink">Fait</button>
            <button onClick={() => mark(i.key, "snoozed")} className="text-muted hover:text-ink">Plus tard</button>
            <button onClick={() => mark(i.key, "ignored")} className="text-muted hover:text-ink">Ignorer</button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Bloc « À traiter » des pages : une vue du fil. */
export function TodayCard({ go, title = "À traiter" }: { go: Go; title?: string }) {
  const { data, reload } = useData<TodayItem[]>("/api/today");
  return (
    <Card title={title} action={data?.length ? <span className="num text-sm text-muted">{data.length}</span> : null}>
      {data?.length ? <TodayList items={data} go={go} onChange={reload} compact /> : <p className="text-sm text-muted">Rien à traiter : aucun relevé en panne, aucune échéance proche.</p>}
    </Card>
  );
}

export function TodayView({ go, banner }: { go: Go; banner?: React.ReactNode }) {
  const { data, reload } = useData<TodayItem[]>("/api/today");
  return (
    <>
      <Header title="Aujourd'hui" sub="Ce qui demande une action : pannes, échéances, objectifs en retard et ce qui peut faire monter vos chiffres." />
      {banner}
      <Card>{data?.length ? <TodayList items={data} go={go} onChange={reload} /> : <EmptyBox>Rien à traiter aujourd'hui.</EmptyBox>}</Card>
    </>
  );
}
