// Analyse des concurrents (plan A6) : votre page face à des pages concurrentes, et les écarts à combler.
import { useEffect, useState, type FormEvent } from "react";
import { api, type Site } from "./api";
import { Button, Card, fmt, inputCls } from "./ui";

type Facts = { url: string; error?: string; ms?: number; kb?: number; title: string | null; description: string | null; h1: string | null; h2: string[]; words: number; images: number; imagesNoAlt: number; internalLinks: number; externalLinks: number; schema: string[]; openGraph: boolean; faq: number };
type Result = { mine: Facts; competitors: Facts[]; gaps: { level: "bad" | "warn" | "info"; text: string }[] };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const ROWS: [string, (f: Facts) => string][] = [
  ["Mots", (f) => fmt(f.words)], ["Intertitres (H2)", (f) => fmt(f.h2.length)], ["Questions en intertitre", (f) => fmt(f.faq)],
  ["Titre", (f) => f.title ? `${f.title.length} car.` : "absent"], ["Meta description", (f) => f.description ? "oui" : "non"],
  ["Données structurées", (f) => f.schema.join(", ") || "aucune"], ["Images (sans alt)", (f) => `${f.images} (${f.imagesNoAlt})`],
  ["Liens internes / externes", (f) => `${f.internalLinks} / ${f.externalLinks}`], ["Temps de réponse", (f) => f.ms == null ? "—" : `${fmt(f.ms)} ms`], ["Poids HTML", (f) => f.kb == null ? "—" : `${fmt(f.kb)} Ko`],
];

export function CompetitorsCard({ site, demo }: { site: Site; demo: boolean }) {
  const [urls, setUrls] = useState("");
  const [r, setR] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api<{ urls: string[] }>(`/api/sites/${site.id}/competitors`).then((x) => setUrls(x.urls.join("\n"))).catch(() => {}); }, [site.id]);
  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    const page = String(new FormData(e.currentTarget).get("url") ?? "/");
    try { setR(await api<Result>(`/api/sites/${site.id}/competitors/compare`, { method: "POST", json: { url: page, competitors: urls.split(/\s+/).filter(Boolean) } })); }
    catch (err) { setError((err as Error).message); }
    setBusy(false);
  }
  const cols = r ? [r.mine, ...r.competitors] : [];
  return (
    <Card title="Concurrents">
      <p className="mb-3 text-sm text-muted">Comparez une de vos pages aux pages qui se classent devant vous sur Google : longueur, structure, balisage, vitesse. Les écarts à combler sont listés en premier.</p>
      {!demo && <form onSubmit={run} className="grid gap-2 lg:grid-cols-[1fr_1.6fr_auto]">
        <input name="url" defaultValue="/" aria-label="Votre page" placeholder="/ma-page" className={inputCls} />
        <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={2} aria-label="Pages concurrentes" placeholder="Adresses des pages concurrentes (une par ligne, 6 au plus)" className={`${inputCls} h-auto py-2`} />
        <Button disabled={busy}>{busy ? "Analyse…" : "Comparer"}</Button>
      </form>}
      {error && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
      {r && <div className="mt-4 space-y-4">
        {r.gaps.length ? <ul className="space-y-1.5">{r.gaps.map((g) => <li key={g.text} className="flex gap-2 text-sm"><span aria-hidden className={`led mt-1.5 ${g.level === "bad" ? "led-bad" : g.level === "warn" ? "led-warn" : "led-off"}`} />{g.text}</li>)}</ul>
          : <p className="text-sm text-positive">Pas d'écart notable avec les pages concurrentes.</p>}
        <div className="-mx-2 overflow-x-auto"><table className="st-table w-full text-sm">
          <caption className="sr-only">Comparaison des pages</caption>
          <thead><tr className="text-left text-xs text-muted"><th scope="col" className="px-2 py-2 font-medium" />{cols.map((c, i) => <th key={c.url} scope="col" className="px-2 py-2 text-right font-medium">{i === 0 ? "Votre page" : host(c.url)}</th>)}</tr></thead>
          <tbody className="divide-y divide-rule">{ROWS.map(([label, get]) => (
            <tr key={label}><th scope="row" className="px-2 py-2 text-left font-normal text-muted">{label}</th>{cols.map((c) => <td key={c.url} className="num px-2 py-2 text-right">{c.error ? <span className="text-negative">{c.error}</span> : get(c)}</td>)}</tr>))}</tbody>
        </table></div>
      </div>}
    </Card>
  );
}
