// Statistiques des réseaux (plan D3) : abonnés et évolution par compte, meilleures publications des 30 derniers jours.
import { useState } from "react";
import { api } from "../../api";
import { useData } from "../../App";
import { Button, Card, Delta, EmptyBox, fmt } from "../../ui";
import { NET_NAME } from "../shared";

type AccountStat = {
  id: string; label: string; network: string; project: string; real: boolean; supported: boolean; unavailable: string | null;
  followers: number | null; followersBefore: number | null; posts: number | null; views: number | null;
  day: string | null; error: string | null; checkedAt: number | null; series: { day: string; followers: number }[];
};
type Top = { id: string; title: string; network: string; url: string | null; day: string; impressions: number | null; likes: number | null; comments: number | null; shares: number | null; views: number | null; engagement: number };
type Data = { days: number; accounts: AccountStat[]; top: Top[] };
const NAME = NET_NAME;

function Line({ series }: { series: { followers: number }[] }) {
  if (series.length < 2) return null;
  const v = series.map((s) => s.followers), min = Math.min(...v), max = Math.max(...v), w = 96, h = 28;
  const d = v.map((x, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * w).toFixed(1)} ${(max === min ? h / 2 : h - 3 - ((x - min) / (max - min)) * (h - 6)).toFixed(1)}`).join("");
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-24" preserveAspectRatio="none" aria-hidden><path d={d} fill="none" stroke="var(--color-positive)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

export function SocialStatsCard({ project }: { project?: string }) {
  const { data, reload } = useData<Data>(`/api/social-stats${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setBusy(true); setError("");
    try { await api(`/api/social-stats/refresh${project ? `?project=${encodeURIComponent(project)}` : ""}`, { method: "POST" }); reload(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const accounts = data?.accounts ?? [];
  return (
    <Card title="Statistiques des réseaux" action={accounts.some((a) => a.supported) && <Button variant="secondary" disabled={busy} onClick={refresh}>{busy ? "Relevé…" : "Relever maintenant"}</Button>}>
      {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
      {!data ? <p className="text-sm text-muted">Chargement…</p> : !accounts.length ? (
        <EmptyBox>Aucun compte de publication. Connectez un réseau dans Connexions : ses abonnés et les chiffres de vos posts seront relevés chaque jour.</EmptyBox>
      ) : (
        <>
          <div className="-mx-2 overflow-x-auto">
            <table className="st-table w-full text-sm">
              <caption className="sr-only">Statistiques par compte sur {data.days} jours</caption>
              <thead><tr className="text-left text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-medium">Compte</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Abonnés</th>
                <th scope="col" className="px-2 py-2 font-medium">Sur {data.days} j</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Posts</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Vues</th>
                <th scope="col" className="px-2 py-2 font-medium"><span className="sr-only">Courbe</span></th>
              </tr></thead>
              <tbody className="divide-y divide-rule">
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td data-label="Compte" className="px-2 py-3">
                      <div className="font-medium">{a.label}</div>
                      <div className="text-xs text-muted">{NAME[a.network] ?? a.network}{a.day ? ` · relevé le ${new Date(a.day).toLocaleDateString("fr-FR")}` : ""}</div>
                      {(a.error || a.unavailable) && <div className={`mt-0.5 text-xs ${a.error ? "text-negative" : "text-muted"}`}>{a.error ?? a.unavailable}</div>}
                    </td>
                    <td data-label="Abonnés" className="px-2 py-3 text-right"><span className="kpi text-[22px] font-medium">{fmt(a.followers)}</span></td>
                    <td data-label={`Sur ${data.days} j`} className="px-2 py-3"><Delta now={a.followers} before={a.followersBefore} /></td>
                    <td data-label="Posts" className="num px-2 py-3 text-right">{fmt(a.posts)}</td>
                    <td data-label="Vues" className="num px-2 py-3 text-right">{fmt(a.views)}</td>
                    <td data-label="Courbe" className="px-2 py-3"><Line series={a.series} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.top.length > 0 && (
            <section className="mt-5" aria-labelledby="top-posts">
              <h3 id="top-posts" className="mb-2 font-medium">Meilleures publications · {data.days} jours</h3>
              <ul className="divide-y divide-rule">{data.top.map((t) => (
                <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
                  <span className="min-w-0 flex-[1_1_240px]">{t.url ? <a href={t.url} target="_blank" rel="noreferrer" className="hover:underline">{t.title}</a> : t.title} <span className="text-xs text-muted">· {NAME[t.network] ?? t.network}</span></span>
                  <span className="num text-xs text-muted">{[t.views ?? t.impressions != null ? `${fmt(t.views ?? t.impressions)} vues` : null, t.likes != null ? `${fmt(t.likes)} j'aime` : null, t.comments != null ? `${fmt(t.comments)} commentaires` : null, t.shares != null ? `${fmt(t.shares)} partages` : null].filter(Boolean).join(" · ")}</span>
                </li>
              ))}</ul>
            </section>
          )}
          <p className="mt-4 text-xs text-muted">Relevé une fois par jour, avec les autorisations déjà accordées à chaque compte. Un chiffre que le réseau ne fournit pas reste « — ».</p>
        </>
      )}
    </Card>
  );
}
