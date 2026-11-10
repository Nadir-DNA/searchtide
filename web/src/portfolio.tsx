// Blocs multi-projets des pages : le pouls du portefeuille, les visites par projet, ce qui demande une action, les projets côte à côte.
import type { ReactNode } from "react";
import { ActivateLink } from "./modules/ActivatePrompt";
import { StackedBars } from "./chart";
import { val } from "./projects";
import { Card, Delta, EmptyBox, fmt } from "./ui";

type Go = (n: Record<string, string | undefined>) => void;
type Kpi = { id: string; label: string; unit: string | null; mode: string; value: number | null; previous: number | null; error: string | null };
type Goal = { label: string; unit: string | null; target: number; done: number; pct: number; projection: number; period: string };
type Row = {
  id: string; name: string; color: string | null; url: string | null; sites: string[]; to: Record<string, string>;
  visitors: number; visitorsPrev: number; clicks: number; clicksPrev: number; impressions: number; position: number | null; positionPrev: number | null;
  revenue: number; revenuePrev: number; mrr: number; hasMoney: boolean; hasSearch: boolean;
  leads: number; leadsPrev: number; open: number; todo: number; series: Record<string, number>; kpis: Kpi[]; goals: Goal[]; issues: number;
};
type Alert = { tone: "bad" | "warn" | "info"; project: string | null; text: string; to: Record<string, string> };
export type Portfolio = {
  range: { from: string; to: string }; today: string; projects: Row[]; daily: Record<string, any>[]; alerts: Alert[];
  totals: { visitors: number; visitorsPrev: number; clicks: number | null; clicksPrev: number | null; revenue: number | null; revenuePrev: number | null; mrr: number | null; leads: number | null; leadsPrev: number | null; open: number | null; todo: number | null };
};

const colorOf = (p: Row) => p.color ?? "var(--color-chart-4)";
const eur = (n: number) => val(n, "€");
const dayList = (from: string, to: string) => { const d: string[] = []; for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) d.push(new Date(t).toISOString().slice(0, 10)); return d; };
// Lien qui remet à zéro les filtres des autres vues
export const target = (to: Record<string, string>) => ({ site: undefined, tab: undefined, view: undefined, id: undefined, ...to });

// ── Le pouls : les cinq chiffres de tout le portefeuille, en une bande ──
export function Pulse({ t, days, go }: { t: Portfolio["totals"]; days: number; go: Go }) {
  const cell = (label: string, value: ReactNode, delta: ReactNode, sub: ReactNode, onClick?: () => void) => {
    const body = (
      <>
        <div className="text-[13px] text-muted">{label}</div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1"><span className="num text-[30px] leading-9 font-light tracking-tight">{value}</span>{delta}</div>
        <div className="mt-1 text-xs text-muted">{sub}</div>
      </>
    );
    const cls = "min-w-0 px-5 py-4 text-left";
    return onClick ? <button onClick={onClick} className={`${cls} transition-colors hover:bg-raised`}>{body}</button> : <div className={cls}>{body}</div>;
  };
  return (
    <section aria-label="Chiffres du portefeuille" className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-surface lg:grid-cols-5 [&>*]:border-rule max-lg:[&>*:nth-child(odd)]:border-r max-lg:[&>*:nth-child(n+3)]:border-t lg:[&>*:not(:first-child)]:border-l max-lg:[&>*:last-child]:col-span-2 max-lg:[&>*:last-child]:border-r-0">
      {cell("Visites", fmt(t.visitors), <Delta now={t.visitors} before={t.visitorsPrev} />, `sur ${days} jours, tous sites`)}
      {t.clicks == null ? cell("Clics Google", "—", null, <ActivateLink module="google" name="Google" go={go} />)
        : cell("Clics Google", fmt(t.clicks), <Delta now={t.clicks} before={t.clicksPrev} />, "Search Console, 2-3 j de retard")}
      {t.revenue == null ? cell("Chiffre d'affaires", "—", null, <ActivateLink module="stripe" name="Stripe" go={go} />)
        : cell("Chiffre d'affaires", eur(t.revenue), <Delta now={t.revenue} before={t.revenuePrev} />, t.mrr ? `MRR ${eur(t.mrr)}` : "encaissé sur Stripe")}
      {t.leads == null ? cell("Nouveaux contacts", "—", null, <ActivateLink module="crm" name="Contacts" go={go} />)
        : cell("Nouveaux contacts", fmt(t.leads), <Delta now={t.leads} before={t.leadsPrev} />, `${fmt(t.open ?? 0)} prospects en cours`, () => go(target({ view: "crm" })))}
      {t.todo == null ? cell("Relances à faire", "—", null, <ActivateLink module="crm" name="Contacts" go={go} />)
        : cell("Relances à faire", fmt(t.todo), null, t.todo ? "aujourd'hui ou en retard" : "rien en attente", () => go(target({ view: "crm", tab: "todo" })))}
    </section>
  );
}

// ── Visites empilées par projet : qui porte le trafic ──
export function TrafficByProject({ o, title = "Visites par projet" }: { o: Portfolio; title?: string }) {
  const days = dayList(o.range.from, o.range.to);
  const byDay = new Map(o.daily.map((d) => [d.day, d]));
  const series = o.projects.filter((p) => p.visitors).sort((a, b) => b.visitors - a.visitors).map((p) => ({ key: p.id || "_", label: p.name, color: colorOf(p), visitors: p.visitors }));
  const total = series.reduce((n, s) => n + s.visitors, 0);
  return (
    <Card title={title}>
      {total ? (
        <>
          <StackedBars label="Visites par projet" days={days} series={series} rows={days.map((d) => byDay.get(d) ?? {})} />
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
                <span>{s.label}</span><span className="num text-muted">{fmt((s.visitors / total) * 100)} %</span>
              </li>
            ))}
          </ul>
        </>
      ) : <EmptyBox>Aucune visite sur la période.</EmptyBox>}
    </Card>
  );
}

// ── Les projets côte à côte ──
function MiniSpark({ series, days, color }: { series: Record<string, number>; days: string[]; color: string }) {
  const v = days.map((d) => series[d] ?? 0);
  const max = Math.max(...v, 1), w = 72, h = 22;
  const d = v.map((x, i) => `${i ? "L" : "M"}${((i / Math.max(v.length - 1, 1)) * w).toFixed(1)},${(h - 1 - (x / max) * (h - 2)).toFixed(1)}`).join("");
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-[22px] w-[72px] shrink-0" preserveAspectRatio="none" aria-hidden><path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

function GoalMini({ g }: { g: Goal }) {
  return (
    <div className="min-w-0" title={`${g.label} : ${val(g.done, g.unit)} sur ${val(g.target, g.unit)}`}>
      <div className="flex justify-between gap-2 text-xs"><span className="truncate text-muted">{g.label}</span><span className="num">{fmt(g.pct)} %</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised"><div className={`h-full rounded-full ${g.projection >= g.target ? "bg-positive" : "bg-chart-3"}`} style={{ width: `${Math.min(g.pct, 100)}%` }} /></div>
    </div>
  );
}

const dash = <span className="text-muted">—</span>;

export function Matrix({ rows, days, range, go, title = "Projets" }: { rows: Row[]; days: number; range: Portfolio["range"]; go: Go; title?: string }) {
  const list = dayList(range.from, range.to);
  const cells = (p: Row) => ({
    visits: p.sites.length ? <span className="inline-flex items-center gap-3"><MiniSpark series={p.series} days={list} color={colorOf(p)} /><span className="num w-14 text-right">{fmt(p.visitors)}</span></span> : dash,
    visitsDelta: p.sites.length ? <Delta now={p.visitors} before={p.visitorsPrev} /> : null,
    clicks: p.hasSearch ? <span className="num">{fmt(p.clicks)}</span> : dash,
    position: p.hasSearch && p.position != null ? <span className="num">{fmt(p.position, 1)}</span> : dash,
    money: p.hasMoney ? <span className="num">{p.mrr && !p.revenue ? `${eur(p.mrr)}/mois` : eur(p.revenue)}</span> : dash,
    contacts: p.open || p.leads ? <span className="num">{fmt(p.leads)}<span className="text-muted"> · {fmt(p.open)}</span></span> : dash,
    kpi: p.kpis[0] ? <span className="block min-w-0"><span className={`num block ${p.kpis[0].error ? "text-negative" : ""}`}>{p.kpis[0].error ? "erreur" : val(p.kpis[0].value, p.kpis[0].unit)}</span><span className="block truncate text-xs text-muted">{p.kpis[0].label}</span></span> : dash,
  });
  const open = (p: Row) => go(target(p.to));
  return (
    <Card title={title} action={<span className="text-sm text-muted">Sur {days} jours</span>}>
      {/* Bureau : une ligne par projet, les mêmes colonnes pour comparer d'un coup d'œil */}
      <div className="-mx-2 hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted [&>th]:h-9 [&>th]:px-2 [&>th]:font-normal">
              <th className="text-left">Projet</th>
              <th className="text-right">Visites</th><th className="w-20" />
              <th className="text-right">Clics Google</th><th className="text-right">Position</th>
              <th className="text-right">Chiffre d'affaires</th>
              <th className="text-right whitespace-nowrap" title="Contacts nouveaux sur la période · prospects en cours">Nouv. · en cours</th>
              <th className="w-40 text-left">Indicateur clé</th>
              <th className="w-44 text-left">Objectif</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const c = cells(p);
              return (
                <tr key={p.id || "_"} onClick={() => open(p)} className="cursor-pointer border-t border-rule transition-colors hover:bg-raised [&>td]:h-16 [&>td]:px-2">
                  <td className="max-w-56">
                    <span className="flex items-center gap-3">
                      <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: colorOf(p) }} aria-hidden />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 font-medium">{p.name}{p.issues > 0 && <span className="size-1.5 rounded-full bg-negative" title={`${p.issues} point${p.issues > 1 ? "s" : ""} à traiter`} />}</span>
                        <span className="block truncate text-xs text-muted">{p.sites.join(", ") || "sans site suivi"}</span>
                      </span>
                    </span>
                  </td>
                  <td className="text-right">{c.visits}</td><td className="text-left">{c.visitsDelta}</td>
                  <td className="text-right">{c.clicks}</td><td className="text-right">{c.position}</td>
                  <td className="text-right">{c.money}</td><td className="text-right">{c.contacts}</td>
                  <td className="max-w-40">{c.kpi}</td>
                  <td className="max-w-44">{p.goals[0] ? <GoalMini g={p.goals[0]} /> : dash}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Téléphone et tablette : une fiche par projet */}
      <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
        {rows.map((p) => {
          const c = cells(p);
          return (
            <li key={p.id || "_"}>
              <button onClick={() => open(p)} className="w-full rounded-xl border border-border p-4 text-left hover:border-control">
                <div className="flex items-center gap-2 font-medium"><span className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(p) }} aria-hidden />{p.name}{p.issues > 0 && <span className="size-1.5 rounded-full bg-negative" />}<span className="ml-auto">{c.visitsDelta}</span></div>
                <div className="truncate text-xs text-muted">{p.sites.join(", ") || "sans site suivi"}</div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-xs text-muted">Visites</dt><dd className="num">{p.sites.length ? fmt(p.visitors) : dash}</dd></div>
                  <div><dt className="text-xs text-muted">Clics</dt><dd>{c.clicks}</dd></div>
                  <div><dt className="text-xs text-muted">CA</dt><dd>{c.money}</dd></div>
                </dl>
                {(p.kpis[0] || p.goals[0]) && <div className="mt-3 grid grid-cols-2 gap-3 border-t border-rule pt-3">{p.kpis[0] && c.kpi}{p.goals[0] && <GoalMini g={p.goals[0]} />}</div>}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
