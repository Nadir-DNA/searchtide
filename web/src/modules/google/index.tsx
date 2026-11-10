// Module Google : Search Console d'un site (clics, impressions, position, mots-clés à faire monter).
import { useEffect, useState, type ReactNode } from "react";
import { api, type Search, type Site, type Traffic } from "../../api";
import { BarChart, Donut, fillDays } from "../../chart";
import { ErrorLine, KpiSkeleton, useData } from "../../App";
import { ActivateLink } from "../ActivatePrompt";
import { Button, Card, Delta, EmptyBox, KpiCard, Segmented, ShareList, Skeleton, Table, fmt, inputCls } from "../../ui";
import { SettingCard } from "../analytics";
type Me = { gsc: boolean; demo: boolean };

export function SearchView({ site, me, days, onChange, onSetup }: { site: Site; me: Me; days: number; onChange: () => void; onSetup: () => void }) {
  const linked = me.gsc && !!site.gsc_property;
  const { data: s, error, reload } = useData<Search>(`/api/sites/${site.id}/search?days=${days}`);
  const [metric, setMetric] = useState<"clicks" | "impressions">("clicks");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  async function sync() {
    setSyncing(true); setSyncError("");
    try { await api(`/api/sites/${site.id}/sync`, { method: "POST" }); reload(); onChange(); }
    catch (e) { setSyncError((e as Error).message); }
    setSyncing(false);
  }
  if (!linked) {
    return (
      <EmptyBox>
        Ce site n'est pas encore relié à Google Search Console : c'est elle qui donne les mots-clés, les clics et la position de chaque page.{" "}
        <button onClick={onSetup} className="text-ink underline">Relier Search Console</button>
      </EmptyBox>
    );
  }
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!s) return <KpiSkeleton />;
  // Google publie avec 2-3 jours de retard : l'axe s'arrête au dernier jour publié au lieu de tomber à zéro
  const chart = fillDays(s.daily, s.range.from, s.daily.at(-1)?.day ?? s.range.to, (d) => d[metric]);
  const buckets = [["Top 3", 0, 3.5], ["4 à 10", 3.5, 10.5], ["11 à 20", 10.5, 20.5], ["Au-delà", 20.5, Infinity]] as const;
  const queryCols = (label: string) => [
    { label, className: "w-1/2", render: (r: Search["queries"][number]) => r.query },
    { label: "Clics", num: true, render: (r: Search["queries"][number]) => fmt(r.clicks) },
    { label: "Impr.", num: true, render: (r: Search["queries"][number]) => fmt(r.impressions) },
    { label: "Position", num: true, render: (r: Search["queries"][number]) => fmt(r.position, 1) },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span className={`size-2 rounded-full ${site.sync_error ? "bg-negative" : "bg-accent"}`} aria-hidden />
        <span>{site.synced_at ? `Importé le ${new Date(site.synced_at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}` : "Pas encore importé"} · Google publie avec 2 à 3 jours de retard</span>
        {!me.demo && <Button variant="secondary" onClick={sync} disabled={syncing} className="ml-auto">{syncing ? "Import en cours…" : "Importer maintenant"}</Button>}
      </div>
      {(syncError || site.sync_error) && <p role="alert" className="text-sm text-negative">{syncError || site.sync_error}</p>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Clics" value={fmt(s.totals.clicks)} delta={<Delta now={s.totals.clicks} before={s.previous.clicks} />} active={metric === "clicks"} onClick={() => setMetric("clicks")} />
        <KpiCard label="Impressions" value={fmt(s.totals.impressions)} delta={<Delta now={s.totals.impressions} before={s.previous.impressions} />} active={metric === "impressions"} onClick={() => setMetric("impressions")} />
        <KpiCard label="Taux de clic" value={s.totals.ctr != null ? `${fmt(s.totals.ctr, 1)} %` : "—"} />
        <KpiCard label="Position moyenne" value={fmt(s.totals.position, 1)} delta={<Delta now={s.totals.position} before={s.previous.position} lowerIsBetter />} hint="Plus c'est bas, mieux c'est" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={metric === "clicks" ? "Clics" : "Impressions"} action={
          <Segmented label="Série" value={metric} onChange={setMetric} options={[["clicks", "Clics"], ["impressions", "Impressions"]] as const} />
        }>
          <BarChart label={metric === "clicks" ? "Clics" : "Impressions"} days={chart.days} values={chart.values} />
        </Card>
        <Card title="Positions des mots-clés">
          <Donut total={s.queries.length} totalLabel="mots-clés" parts={buckets.map(([label, lo, hi]) => ({ label, value: s.queries.filter((q) => q.position > lo && q.position <= hi).length })).filter((p) => p.value)} />
        </Card>
      </div>
      <Card title="À travailler en priorité" action={<span className="text-sm text-muted">Position 4 à 20, déjà des impressions</span>}>
        <Table rows={s.opportunities.slice(0, 8)} empty="Aucun mot-clé entre la 4e et la 20e position sur cette période." cols={queryCols("Mot-clé")} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mots-clés"><Table rows={s.queries.slice(0, 8)} empty="Aucun mot-clé sur cette période." cols={queryCols("Mot-clé")} /></Card>
        <Card title="Pages">
          <Table rows={s.pages.slice(0, 8)} empty="Aucune page sur cette période." cols={[
            { label: "Page", className: "w-1/2", render: (r) => r.page.replace(/^https?:\/\/[^/]+/, "") || "/" },
            { label: "Clics", num: true, render: (r) => fmt(r.clicks) },
            { label: "Impr.", num: true, render: (r) => fmt(r.impressions) },
            { label: "Position", num: true, render: (r) => fmt(r.position, 1) },
          ]} />
        </Card>
      </div>
    </div>
  );
}
