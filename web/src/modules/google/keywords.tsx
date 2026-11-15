// Suivi de mots-clés et diagnostics Search Console (plan A4), dans l'onglet Recherche d'un site ou d'un projet.
import { useState, type FormEvent } from "react";
import { api, type Site } from "../../api";
import { useData } from "../../App";
import { Button, Card, EmptyBox, fmt, inputCls } from "../../ui";

type Tracked = {
  query: string; clicks: number; impressions: number; position: number | null; page: string | null;
  previous: { clicks: number; impressions: number; position: number | null };
  series: { day: string; position: number }[];
};
type Suggestion = { query: string; clicks: number; impressions: number; position: number };
type Insights = {
  losing: { page: string; clicks: number; previousClicks: number; lost: number; position: number | null }[];
  lowCtr: { page: string; impressions: number; clicks: number; position: number; ctr: number; expected: number }[];
  cannibal: { query: string; impressions: number; pages: { page: string; impressions: number; position: number }[] }[];
};

const path = (url: string | null) => (url ?? "").replace(/^https?:\/\/[^/]+/, "") || "/";

/** Gain de places sur la période précédente : positif = le mot-clé monte. Toujours flèche + signe + texte. */
function Move({ now, before }: { now: number | null; before: number | null }) {
  if (now == null || before == null) return <span className="text-xs text-muted">nouveau</span>;
  const gain = Math.round((before - now) * 10) / 10;
  if (Math.abs(gain) < 0.5) return <span className="text-xs text-muted"><span aria-hidden>– </span>stable</span>;
  return <span className={`num text-xs font-semibold ${gain > 0 ? "text-positive" : "text-negative"}`}><span aria-hidden className="mr-1 text-[9px]">{gain > 0 ? "▲" : "▼"}</span>{gain > 0 ? "+" : "−"}{fmt(Math.abs(gain), 1)} place{Math.abs(gain) >= 2 ? "s" : ""}</span>;
}

/** Courbe de position : en haut = meilleure position. Décorative, la valeur est écrite à côté. */
function PositionLine({ series }: { series: { position: number }[] }) {
  if (series.length < 2) return null;
  const v = series.map((s) => s.position), min = Math.min(...v), max = Math.max(...v), w = 96, h = 28;
  const d = v.map((p, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * w).toFixed(1)} ${(max === min ? h / 2 : 3 + ((p - min) / (max - min)) * (h - 6)).toFixed(1)}`).join("");
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-24" preserveAspectRatio="none" aria-hidden><path d={d} fill="none" stroke="var(--color-chart-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

export function KeywordsPanel({ site, days, demo }: { site: Site; days: number; demo: boolean }) {
  const { data, reload } = useData<{ tracked: Tracked[]; suggestions: Suggestion[] }>(`/api/sites/${site.id}/keywords?days=${days}`);
  const { data: ins } = useData<Insights>(`/api/sites/${site.id}/seo-insights?days=${days}`);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const track = async (q: string, tracked = true) => {
    setError("");
    try { await api(`/api/sites/${site.id}/keywords`, { method: "POST", json: { query: q, tracked } }); setQuery(""); reload(); }
    catch (e) { setError((e as Error).message); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (query.trim()) void track(query); };
  const tracked = data?.tracked ?? [];

  return (
    <>
      <Card title="Mots-clés suivis" action={!demo && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ajouter un mot-clé" aria-label="Mot-clé à suivre" className={`${inputCls} h-9 w-56`} />
          <Button variant="secondary" disabled={!query.trim()}>Suivre</Button>
        </form>
      )}>
        {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
        {!data ? <p className="text-sm text-muted">Chargement…</p> : tracked.length === 0 ? (
          <EmptyBox>Aucun mot-clé suivi. Ajoutez ceux qui comptent pour votre activité, ou choisissez parmi les suggestions ci-dessous : leur position est relevée chaque jour depuis Search Console.</EmptyBox>
        ) : (
          <div className="-mx-2 overflow-x-auto">
            <table className="st-table w-full text-sm">
              <caption className="sr-only">Mots-clés suivis sur {days} jours</caption>
              <thead><tr className="text-left text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-medium">Mot-clé</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Position</th>
                <th scope="col" className="px-2 py-2 font-medium">Évolution</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Clics</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Impressions</th>
                <th scope="col" className="px-2 py-2 font-medium"><span className="sr-only">Courbe</span></th>
                {!demo && <th scope="col" className="px-2 py-2"><span className="sr-only">Actions</span></th>}
              </tr></thead>
              <tbody className="divide-y divide-rule">
                {tracked.map((k) => (
                  <tr key={k.query}>
                    <td data-label="Mot-clé" className="px-2 py-3"><div className="font-medium">{k.query}</div>{k.page && <div className="truncate text-xs text-muted">{path(k.page)}</div>}</td>
                    <td data-label="Position" className="px-2 py-3 text-right"><span className="kpi text-[22px] font-medium">{k.position == null ? "—" : fmt(k.position, 1)}</span></td>
                    <td data-label="Évolution" className="px-2 py-3"><Move now={k.position} before={k.previous.position} /></td>
                    <td data-label="Clics" className="num px-2 py-3 text-right">{fmt(k.clicks)}</td>
                    <td data-label="Impressions" className="num px-2 py-3 text-right">{fmt(k.impressions)}</td>
                    <td data-label="Courbe" className="px-2 py-3"><PositionLine series={k.series} /></td>
                    {!demo && <td className="px-2 py-3 text-right"><button type="button" onClick={() => track(k.query, false)} aria-label={`Ne plus suivre ${k.query}`} className="text-xs text-muted underline hover:text-ink">Retirer</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!demo && data && data.suggestions.length > 0 && (
          <div className="mt-4">
            <p className="label-caps mb-2">Suggestions · position 4 à 20</p>
            <ul className="flex flex-wrap gap-2">
              {data.suggestions.map((s) => (
                <li key={s.query}><button type="button" onClick={() => track(s.query)} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-control px-3 text-sm hover:bg-raised">
                  <span aria-hidden>+</span>{s.query}<span className="num text-xs text-muted">pos. {fmt(s.position, 1)}</span>
                </button></li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Diagnostics">
        {!ins ? <p className="text-sm text-muted">Chargement…</p> : (
          <div className="grid gap-6 lg:grid-cols-3">
            <section aria-labelledby="diag-perd">
              <h3 id="diag-perd" className="mb-1 font-medium">Pages qui perdent des clics</h3>
              <p className="mb-2 text-xs text-muted">Par rapport aux {days} jours précédents.</p>
              {ins.losing.length ? <ul className="divide-y divide-rule">{ins.losing.map((x) => (
                <li key={x.page} className="flex items-baseline justify-between gap-3 py-2 text-sm"><span className="min-w-0 truncate">{path(x.page)}</span>
                  <span className="num shrink-0 text-negative"><span aria-hidden className="mr-1 text-[9px]">▼</span>−{fmt(x.lost)} clics</span></li>
              ))}</ul> : <p className="text-sm text-muted">Aucune page en baisse nette.</p>}
            </section>
            <section aria-labelledby="diag-ctr">
              <h3 id="diag-ctr" className="mb-1 font-medium">Titre ou description à réécrire</h3>
              <p className="mb-2 text-xs text-muted">Bien placées mais peu cliquées : taux de clic sous la moitié de la moyenne estimée pour leur position.</p>
              {ins.lowCtr.length ? <ul className="divide-y divide-rule">{ins.lowCtr.map((x) => (
                <li key={x.page} className="py-2 text-sm"><div className="truncate">{path(x.page)}</div>
                  <div className="num text-xs text-muted">position {fmt(x.position, 1)} · {fmt(x.ctr, 1)} % de clics (moyenne estimée ~{fmt(x.expected, 1)} %) · {fmt(x.impressions)} impressions</div></li>
              ))}</ul> : <p className="text-sm text-muted">Rien d'anormal.</p>}
            </section>
            <section aria-labelledby="diag-cannibal">
              <h3 id="diag-cannibal" className="mb-1 font-medium">Pages en concurrence</h3>
              <p className="mb-2 text-xs text-muted">Plusieurs de vos pages se partagent la même requête : regroupez-les ou distinguez-les.</p>
              {ins.cannibal.length ? <ul className="divide-y divide-rule">{ins.cannibal.map((x) => (
                <li key={x.query} className="py-2 text-sm"><div className="font-medium">« {x.query} »</div>
                  <div className="text-xs text-muted">{x.pages.map((p) => `${path(p.page)} (pos. ${fmt(p.position, 1)})`).join(" · ")}</div></li>
              ))}</ul> : <p className="text-sm text-muted">Aucune requête partagée.</p>}
            </section>
          </div>
        )}
      </Card>
    </>
  );
}
