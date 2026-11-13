// Mur de projets : l'accueil de Searchtide. Un coup d'œil sur le portefeuille (totaux), une grande tuile par projet
// (état, chiffre principal, courbe, six chiffres clés, prochaine action) et ce qui demande une action.
import { useMemo } from "react";
import { ErrorLine, Header, KpiSkeleton, useData } from "./App";
import { columnTotal } from "./portefeuille-total";
import { target } from "./portfolio";
import { TodayCard, type TodayItem } from "./today";
import { formatMeasure, GRID, HEADLINE, SOURCE_HINT, type Column, type Measure } from "./measures";
import { Button, Delta, EmptyBox, Pill, fmt } from "./ui";

type Go = (n: Record<string, string | undefined>) => void;
type Health = { score: number | null; coverage: number; tone: "positive" | "warn" | "negative" | "none"; partial: boolean; missing: string[] };
type Row = { id: string; name: string; color: string | null; measures: Record<string, Measure>; health: Health | null; series: Record<string, number>; issues: number };
type Data = { columns: Column[]; projects: Row[] };
type Fresh = { project_id: string; state: "ok" | "stale" | "error" | "never"; label: string };

const STATUS = {
  positive: { label: "En forme", bar: "bg-positive", pill: "positive" as const },
  warn: { label: "À surveiller", bar: "bg-warn", pill: "warn" as const },
  negative: { label: "À redresser", bar: "bg-negative", pill: "negative" as const },
  none: { label: "Pas assez de données", bar: "bg-control", pill: "neutral" as const },
};
const ORDER = { bad: 0, warn: 1, info: 2 } as const;

/** Courbe de fond d'une tuile : visites par jour. Décorative, la valeur est lisible dans le texte. */
function Trend({ series, tone }: { series: Record<string, number>; tone: "positive" | "warn" | "negative" | "none" }) {
  const vals = Object.keys(series).sort().map((d) => series[d]);
  if (vals.length < 2) return null;
  const max = Math.max(...vals, 1), w = 260, h = 84;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 6 - (v / max) * (h - 14)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const color = tone === "negative" ? "var(--color-negative)" : tone === "warn" ? "var(--color-warn)" : "var(--color-positive)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className="h-[84px] min-w-0 flex-[1_1_160px]">
      <path d={`${line}V${h}H0z`} fill={color} fillOpacity=".12" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r="3.5" fill={color} />
    </svg>
  );
}

function Tile({ label, value, delta, small = false }: { label: string; value: string; delta?: React.ReactNode; small?: boolean }) {
  return (
    <div className={`min-w-0 border-r border-b border-border bg-surface ${small ? "px-4 py-3" : "px-6 py-5"}`}>
      <div className="label-caps truncate">{label}</div>
      <div className={`kpi mt-2 font-medium ${small ? "text-[22px]" : "text-[40px]"}`}>{value}</div>
      {delta && <div className="mt-2 min-h-6">{delta}</div>}
    </div>
  );
}

export function WallView({ days, go }: { days: number; go: Go }) {
  const { data, error, reload } = useData<Data>(`/api/portfolio?days=${days}`);
  const { data: today } = useData<TodayItem[]>("/api/today");
  const { data: fresh } = useData<Fresh[]>("/api/freshness");
  const projects = useMemo(() => (data?.projects ?? []).filter((p) => p.id), [data]);

  // Totaux : seulement les mesures que ce portefeuille possède, jamais un faux zéro ni des devises additionnées.
  const totals = useMemo(() => {
    const cols = data?.columns ?? [];
    return (["visitors", "clicks", "impressions", "revenue", "mrr", "leads", "pipeline", "published"] as const).flatMap((key) => {
      const col = cols.find((c) => c.key === key);
      const vals = projects.map((p) => p.measures[key] ?? { value: null, previous: null, unit: null });
      if (!col || vals.every((m) => m.value == null)) return [];
      const now = columnTotal(col.kind, vals);
      const before = columnTotal(col.kind, vals.map((m) => ({ value: m.previous, unit: m.unit })));
      return [{ col, now, before }];
    }).slice(0, 6);
  }, [data, projects]);

  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!data) return <KpiSkeleton />;

  const stale = (fresh ?? []).filter((f) => f.state !== "ok");
  const items = [...(today ?? [])].sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);

  return (
    <>
      <Header title="Vos projets" days={days} go={go}
        sub={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{projects.length} projet{projects.length > 1 ? "s" : ""} · {days} derniers jours</span>
            {fresh && (stale.length
              ? <button type="button" onClick={() => go({ view: "settings" })} className="inline-flex items-center gap-2 text-warn hover:underline"><span className="led led-warn" aria-hidden />{stale.length} source{stale.length > 1 ? "s" : ""} à vérifier</button>
              : fresh.length > 0 && <span className="inline-flex items-center gap-2 text-positive"><span className="led led-ok" aria-hidden />{fresh.length} source{fresh.length > 1 ? "s" : ""} à jour</span>)}
          </span>
        }>
        <Button variant="secondary" onClick={() => go({ view: "projects" })}>Comparer en tableau</Button>
        <Button onClick={() => go({ view: "newproject" })}>Nouveau projet</Button>
      </Header>

      {!projects.length ? (
        <EmptyBox>Aucun projet pour l'instant. <button type="button" onClick={() => go({ view: "newproject" })} className="text-ink underline">Créer le premier</button></EmptyBox>
      ) : (
        <div className="space-y-6">
          {totals.length > 0 && (
            <section aria-label="Total du portefeuille">
              <div className="overflow-hidden rounded-2xl border border-border"><div className="-mr-px -mb-px grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {totals.map(({ col, now, before }) => (
                  <Tile key={col.key} label={col.label}
                    value={now.mixed ? "Devises mélangées" : now.value == null ? "—" : formatMeasure({ value: now.value, previous: null, unit: now.unit }, col.kind)}
                    delta={now.mixed ? null : <Delta now={now.value} before={before.value} lowerIsBetter={col.lowerIsBetter} />} />
                ))}
              </div></div>
            </section>
          )}

          <section aria-label="Projets" className="grid gap-5 md:grid-cols-[repeat(auto-fit,minmax(min(100%,440px),1fr))]">
            {projects.map((p) => {
              const st = STATUS[p.health?.tone ?? "none"];
              const tone = p.health?.tone ?? "none";
              const headKey = HEADLINE.find((k) => p.measures[k]?.value != null);
              const col = (k: string) => data.columns.find((c) => c.key === k);
              const head = headKey ? p.measures[headKey] : null;
              const cells = GRID.filter((k) => k !== headKey && p.measures[k]?.value != null).slice(0, 6);
              const missing = (["clicks", "revenue", "leads"] as const).filter((k) => k !== headKey && p.measures[k]?.value == null).slice(0, Math.max(0, 6 - cells.length));
              const mine = (fresh ?? []).filter((f) => f.project_id === p.id);
              const bad = mine.some((f) => f.state === "error"), late = mine.filter((f) => f.state !== "ok").length;
              const next = items.find((i) => i.project_id === p.id);
              const open = () => go({ view: "project", id: p.id, site: undefined });
              return (
                <article key={p.id} className="flex min-w-0 flex-col overflow-hidden rounded-[18px] border border-border bg-surface">
                  <div className={`h-1 ${st.bar}`} aria-hidden />
                  <div className="flex items-center gap-3 px-6 pt-5">
                    <span aria-hidden className="size-3.5 shrink-0 rounded" style={{ background: p.color ?? "var(--color-accent)" }} />
                    <h2 className="min-w-0 flex-1 truncate text-xl font-medium"><button type="button" onClick={open} className="hover:underline">{p.name}</button></h2>
                    <Pill tone={st.pill}>{p.health?.partial && p.health.score != null ? `Score ${p.health.score} · partiel` : `${st.label}${p.health?.score != null ? ` · ${p.health.score}` : ""}`}</Pill>
                  </div>
                  <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-6 pt-5">
                    {head && headKey && col(headKey) ? (
                      <div className="min-w-0">
                        <div className="label-caps">{col(headKey)!.label}</div>
                        <div className="kpi mt-2 text-[52px] font-medium sm:text-[60px]">{formatMeasure(head, col(headKey)!.kind)}</div>
                        <div className="mt-2 min-h-6"><Delta now={head.value} before={head.previous} lowerIsBetter={col(headKey)!.lowerIsBetter} /></div>
                      </div>
                    ) : (
                      <p className="max-w-xs text-sm text-muted">Aucun chiffre pour l'instant. Rattachez une source pour voir ce projet vivre.</p>
                    )}
                    <Trend series={p.series} tone={tone} />
                  </div>
                  <div className="mt-5 overflow-hidden border-y border-border"><div className="-mr-px -mb-px grid grid-cols-2 sm:grid-cols-3">
                    {cells.map((k) => (
                      <Tile key={k} small label={col(k)!.label} value={formatMeasure(p.measures[k], col(k)!.kind)}
                        delta={<Delta now={p.measures[k].value} before={p.measures[k].previous} lowerIsBetter={col(k)!.lowerIsBetter} />} />
                    ))}
                    {missing.map((k) => (
                      <div key={k} className="min-w-0 border-r border-b border-border bg-surface px-4 py-3">
                        <div className="label-caps truncate">{SOURCE_HINT[k].label}</div>
                        <div className="kpi mt-2 text-[22px] font-medium text-muted">—</div>
                        <button type="button" onClick={() => go({ ...SOURCE_HINT[k].to, project: p.id })} className="mt-2 text-xs font-semibold text-accent hover:underline">{SOURCE_HINT[k].action}</button>
                      </div>
                    ))}
                  </div></div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4">
                    <div className="min-w-0 flex-[1_1_220px] text-sm">
                      {next
                        ? <button type="button" onClick={() => go(target(next.to))} className="flex items-start gap-2.5 text-left hover:underline"><span aria-hidden className={`led mt-1.5 ${next.tone === "bad" ? "led-bad" : next.tone === "warn" ? "led-warn" : "led-ok"}`} /><span>{next.text}</span></button>
                        : <span className="flex items-center gap-2.5 text-muted"><span aria-hidden className="led led-ok" />Rien à traiter</span>}
                      {mine.length > 0 && <div className="mt-1 pl-[18px] text-xs text-muted">{late ? `${mine.length - late} source${mine.length - late > 1 ? "s" : ""} sur ${mine.length} à jour${bad ? ", dont un relevé en erreur" : ""}` : `${mine.length} source${mine.length > 1 ? "s" : ""} à jour`}</div>}
                    </div>
                    <Button variant={next && next.tone !== "info" ? "primary" : "secondary"} onClick={open} aria-label={`Ouvrir ${p.name}`}>{next && next.tone !== "info" ? "Comprendre" : "Ouvrir"} →</Button>
                  </div>
                </article>
              );
            })}
          </section>

          <TodayCard go={go} />
        </div>
      )}
    </>
  );
}
