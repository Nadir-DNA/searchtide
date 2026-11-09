// Vue Portefeuille (04-produit §5.5) : les projets côte à côte avec leur score de santé et la couverture de ce score, les colonnes au choix
// (choix et ordre enregistrés), tri au clic sur l'en-tête (aria-sort), « — » quand la période précédente vaut 0 ou qu'aucune source n'est rattachée,
// et une ligne Total qui n'additionne jamais des devises différentes.
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { ErrorLine, Header, KpiSkeleton, useData } from "./App";
import { Button, Card, EmptyBox, fmt } from "./ui";
import { columnTotal } from "./portefeuille-total";

type Go = (n: Record<string, string | undefined>) => void;
type Measure = { value: number | null; previous: number | null; unit: string | null };
type Health = { score: number | null; coverage: number; tone: "positive" | "warn" | "negative" | "none"; partial: boolean; missing: string[] };
type Column = { key: string; label: string; kind: "count" | "money" | "score" | "rating" | "position" | "seconds" | "ratio"; lowerIsBetter?: boolean };
type Row = { id: string; name: string; color: string | null; measures: Record<string, Measure>; health: Health | null };
type Data = { columns: Column[]; projects: Row[] };

const DEFAULTS = ["visitors", "clicks", "revenue", "mrr"];
const TONE = { positive: "text-positive", warn: "text-ink", negative: "text-negative", none: "text-muted" } as const;

const num = (v: number, kind: Column["kind"]) => kind === "rating" ? fmt(v, 1) : kind === "ratio" ? fmt(v, 3) : kind === "seconds" ? fmt(v, 2) : fmt(v, Math.abs(v) < 100 && v % 1 ? 1 : 0);
const money = (v: number, unit: string | null) => { const u = unit ?? "€"; return `${fmt(v, Math.abs(v) < 100 && v % 1 ? 2 : 0)} ${u}`; };
const show = (m: Measure, c: Column) => (m.value == null ? "—" : c.kind === "money" ? money(m.value, m.unit) : c.kind === "score" ? `${fmt(m.value, 0)}` : `${num(m.value, c.kind)}${c.kind === "seconds" ? " s" : ""}`);

/** Variation en %, « — » quand la période précédente est absente ou vaut 0. Vert = bonne nouvelle (pour la position, une baisse). */
function Variation({ m, c }: { m: Measure; c: Column }) {
  if (m.value == null || m.previous == null || m.previous === 0) return <span className="text-muted" aria-label="variation indisponible">—</span>;
  const change = ((m.value - m.previous) / Math.abs(m.previous)) * 100;
  const good = c.lowerIsBetter ? change < 0 : change > 0;
  const tone = Math.abs(change) < 0.05 ? "text-muted" : good ? "text-positive" : "text-negative";
  return <span className={tone}>{change > 0 ? "+" : change < 0 ? "−" : ""}{fmt(Math.abs(change), 1)} %</span>;
}

export function PortfolioView({ days, go }: { days: number; go: Go }) {
  const { data, error, reload } = useData<Data>(`/api/portfolio?days=${days}`);
  const { data: saved, reload: reloadSaved } = useData<{ columns: string[] | null }>("/api/portfolio/columns");
  const [sort, setSort] = useState<{ key: string; dir: "ascending" | "descending" }>({ key: "health", dir: "descending" });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const available = data?.columns ?? [];
  const chosen = useMemo(() => {
    const keys = (saved?.columns ?? DEFAULTS).filter((k) => available.some((c) => c.key === k));
    return keys.length || saved?.columns ? keys : available.slice(0, 4).map((c) => c.key);
  }, [saved, available]);
  const cols = chosen.map((k) => available.find((c) => c.key === k)!).filter(Boolean);
  const projects = (data?.projects ?? []).filter((p) => p.id);

  const rows = useMemo(() => {
    const val = (p: Row) => sort.key === "health" ? p.health?.score ?? null : sort.key === "coverage" ? p.health?.coverage ?? null : sort.key === "name" ? p.name.toLowerCase() : p.measures[sort.key]?.value ?? null;
    return [...projects].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return a.name.localeCompare(b.name);
      if (x == null) return 1; if (y == null) return -1;               // les valeurs absentes restent toujours en bas
      const d = typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number);
      return sort.dir === "ascending" ? d : -d;
    });
  }, [projects, sort]);

  async function saveColumns(next: string[]) {
    setMsg("");
    try { await api("/api/portfolio/columns", { method: "PUT", json: { columns: next } }); reloadSaved(); }
    catch (e) { setMsg((e as Error).message); }
  }
  const toggle = (k: string) => saveColumns(chosen.includes(k) ? chosen.filter((x) => x !== k) : [...chosen, k]);
  const move = (k: string, d: -1 | 1) => { const i = chosen.indexOf(k), j = i + d; if (i < 0 || j < 0 || j >= chosen.length) return; const n = [...chosen]; [n[i], n[j]] = [n[j], n[i]]; void saveColumns(n); };
  const ariaSort = (key: string) => sort.key === key ? sort.dir : "none";
  const sortBy = (key: string) => setSort((s) => s.key === key ? { key, dir: s.dir === "ascending" ? "descending" : "ascending" } : { key, dir: key === "name" ? "ascending" : "descending" });

  // Ligne Total : calcul côté serveur (columnTotal), jamais d'addition de devises différentes
  const total = (c: Column) => {
    const t = columnTotal(c.kind, projects.map((p) => p.measures[c.key] ?? { value: null, unit: null }));
    if (t.mixed) return "Devises mélangées";
    if (t.value == null) return "—";
    return c.kind === "money" ? money(t.value, t.unit) : fmt(t.value, 0);
  };

  useEffect(() => { if (!open) return; const f = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false); addEventListener("keydown", f); return () => removeEventListener("keydown", f); }, [open]);
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!data) return <KpiSkeleton />;

  const th = "px-3 py-3 text-left text-xs font-medium whitespace-nowrap text-muted";
  const sortBtn = (key: string, label: string) => (
    <button type="button" onClick={() => sortBy(key)} className="inline-flex items-center gap-1 hover:text-ink">
      {label}<span aria-hidden>{sort.key === key ? (sort.dir === "ascending" ? "▲" : "▼") : ""}</span>
    </button>
  );

  return (
    <>
      <Header title="Portefeuille" sub="Vos projets côte à côte : santé, couverture et chiffres clés" days={days} go={go}>
        <div className="relative">
          <Button variant="secondary" aria-expanded={open} aria-controls="colonnes" onClick={() => setOpen(!open)}>Colonnes ▾</Button>
          {open && (
            <div id="colonnes" role="group" aria-label="Colonnes affichées" className="absolute right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-4 shadow-xl">
              <p className="mb-2 text-xs text-muted">Cochez les chiffres à comparer, puis réordonnez-les.</p>
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {available.map((c) => (
                  <li key={c.key} className="flex items-center gap-2 text-sm">
                    <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={chosen.includes(c.key)} onChange={() => toggle(c.key)} className="size-4 accent-[var(--color-accent)]" /><span className="truncate">{c.label}</span></label>
                    {chosen.includes(c.key) && <>
                      <button type="button" aria-label={`Monter ${c.label}`} onClick={() => move(c.key, -1)} className="px-1.5 text-muted hover:text-ink">↑</button>
                      <button type="button" aria-label={`Descendre ${c.label}`} onClick={() => move(c.key, 1)} className="px-1.5 text-muted hover:text-ink">↓</button>
                    </>}
                  </li>
                ))}
              </ul>
              {msg && <p role="alert" className="mt-2 text-xs text-negative">{msg}</p>}
            </div>
          )}
        </div>
      </Header>

      {!projects.length ? (
        <EmptyBox>Aucun projet pour l'instant. <button type="button" onClick={() => go({ view: "newproject", id: undefined, site: undefined })} className="text-ink underline">Créer le premier</button></EmptyBox>
      ) : (
        <Card className="p-0 sm:p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm">
              <caption className="sr-only">Comparaison des projets sur {days} jours</caption>
              <thead>
                <tr className="border-b border-rule">
                  <th scope="col" aria-sort={ariaSort("name")} className={th}>{sortBtn("name", "Projet")}</th>
                  <th scope="col" aria-sort={ariaSort("health")} className={th}>{sortBtn("health", "Santé")}</th>
                  <th scope="col" aria-sort={ariaSort("coverage")} className={th}>{sortBtn("coverage", "Couverture")}</th>
                  {cols.map((c) => <th key={c.key} scope="col" aria-sort={ariaSort(c.key)} className={`${th} text-right`} colSpan={2}>{sortBtn(c.key, c.label)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rows.map((p) => (
                  <tr key={p.id}>
                    <th scope="row" className="px-3 py-3 text-left font-normal">
                      <button type="button" onClick={() => go({ view: "project", id: p.id, site: undefined })} className="flex items-center gap-2 hover:underline"><span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: p.color ?? "var(--color-accent)" }} />{p.name}</button>
                    </th>
                    <td className="px-3 py-3">
                      {p.health?.score == null ? <span className="text-muted">—</span> : (
                        <span className={`num font-medium ${p.health.partial ? "text-muted" : TONE[p.health.tone]}`}>
                          <span aria-hidden className="mr-1.5">●</span>{p.health.score}
                          {p.health.partial && <><span aria-hidden title={`Score partiel : ${p.health.missing.join(", ")}`} className="ml-1.5 text-negative">⚠</span><span className="sr-only"> Score partiel : {p.health.missing.join(", ")}</span></>}
                          <span className="sr-only">{p.health.tone === "positive" ? " bon" : p.health.tone === "warn" ? " moyen" : p.health.tone === "negative" ? " faible" : ""}</span>
                        </span>
                      )}
                    </td>
                    <td className="num px-3 py-3 text-muted">{p.health ? `${p.health.coverage} %` : "—"}</td>
                    {cols.map((c) => {
                      const m = p.measures[c.key];
                      return m ? (
                        <><td key={c.key} className="num px-3 py-3 text-right">{show(m, c)}</td><td key={c.key + "d"} className="num py-3 pr-3 text-right text-xs"><Variation m={m} c={c} /></td></>
                      ) : (
                        <td key={c.key} colSpan={2} className="px-3 py-3 text-right text-muted" title="Source non rattachée">
                          —{" "}<button type="button" onClick={() => go({ view: "project", id: p.id, site: undefined })} aria-label={`Rattacher une source à ${p.name} pour ${c.label}`} className="text-xs text-accent underline">Rattacher</button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-raised/50">
                  <th scope="row" className="px-3 py-3 text-left font-medium">Total</th>
                  <td /><td />
                  {cols.map((c) => <td key={c.key} colSpan={2} className={`num px-3 py-3 text-right ${total(c) === "Devises mélangées" ? "text-xs text-muted" : "font-medium"}`}>{total(c)}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}
      {cols.length === 0 && projects.length > 0 && <p className="mt-3 text-sm text-muted">Aucune mesure disponible pour l'instant : rattachez des sources à vos projets (page du projet → Sources).</p>}
    </>
  );
}
