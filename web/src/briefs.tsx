// Briefs et articles (plan B3) : sujets tirés de Search Console, brief (plan, questions, liens), brouillon par l'IA, envoi WordPress.
import { useState, type FormEvent } from "react";
import { api, type Site } from "./api";
import { useData } from "./App";
import { Button, Card, EmptyBox, fmt, inputCls } from "./ui";

type Idea = { query: string; impressions: number; clicks: number; position: number };
type Listed = { id: string; query: string; title: string | null; status: string; wp_link: string | null; updated_at: number };
type Brief = { id: string; query: string; title: string | null; draft: string | null; status: string; wp_link: string | null;
  data: { position: number | null; impressions: number; page: string | null; related: { query: string; impressions: number }[]; questions: string[]; links: { page: string; query: string }[];
    competitors: { url: string; title: string | null; headings: string[]; words: number; error?: string }[]; outline: { title: string; h2: string[] }; length: number } };
const STATUS: Record<string, string> = { brief: "Brief", draft: "Brouillon", sent: "Envoyé dans WordPress" };
const path = (u: string | null) => (u ?? "").replace(/^https?:\/\/[^/]+/, "") || "/";

export function BriefsCard({ site, demo }: { site: Site; demo: boolean }) {
  const { data, reload } = useData<{ briefs: Listed[]; ideas: Idea[]; ai: boolean; wordpress: boolean }>(`/api/sites/${site.id}/briefs`);
  const [open, setOpen] = useState<Brief | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setError(""); try { await fn(); } catch (e) { setError((e as Error).message); } setBusy(""); };
  const create = (query: string, competitors: string[] = []) => run("create", async () => { setOpen(await api<Brief>(`/api/sites/${site.id}/briefs`, { method: "POST", json: { query, competitors } })); reload(); });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void create(String(f.get("query") ?? ""), String(f.get("competitors") ?? "").split(/\s+/).filter(Boolean));
  };
  const load = (id: string) => run("load", async () => setOpen(await api<Brief>(`/api/briefs/${id}`)));
  const write = () => open && run("draft", async () => { setOpen(await api<Brief>(`/api/briefs/${open.id}/draft`, { method: "POST", json: {} })); reload(); });
  const save = () => open && run("save", async () => { setOpen(await api<Brief>(`/api/briefs/${open.id}`, { method: "PUT", json: { title: open.title, draft: open.draft } })); reload(); });
  const send = () => open && run("wp", async () => { await api(`/api/briefs/${open.id}`, { method: "PUT", json: { title: open.title, draft: open.draft } }); setOpen(await api<Brief>(`/api/briefs/${open.id}/wordpress`, { method: "POST" })); reload(); });

  return (
    <Card title="Articles à écrire">
      {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
      {!data ? <p className="text-sm text-muted">Chargement…</p> : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="space-y-4">
            {!demo && <form onSubmit={submit} className="space-y-2">
              <input name="query" required placeholder="Requête visée, ex. devis toiture" aria-label="Requête visée" className={inputCls} />
              <textarea name="competitors" rows={2} placeholder="Pages concurrentes à analyser (adresses séparées par des espaces, facultatif)" aria-label="Pages concurrentes" className={`${inputCls} h-auto py-2`} />
              <Button disabled={!!busy}>{busy === "create" ? "Analyse…" : "Préparer le brief"}</Button>
            </form>}
            <div>
              <p className="label-caps mb-2">Sujets suggérés · position 5 à 30</p>
              {data.ideas.length ? <ul className="divide-y divide-rule">{data.ideas.map((i) => (
                <li key={i.query} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{i.query}</span>
                  <span className="num shrink-0 text-xs text-muted">pos. {fmt(i.position, 1)} · {fmt(i.impressions)} impr.</span>
                  {!demo && <button type="button" disabled={!!busy} onClick={() => create(i.query)} className="shrink-0 text-xs font-semibold text-accent hover:underline">Brief</button>}
                </li>))}</ul> : <EmptyBox>Pas encore de sujet : il faut des requêtes Search Console en position 5 à 30 sur 90 jours.</EmptyBox>}
            </div>
            {data.briefs.length > 0 && <div>
              <p className="label-caps mb-2">Vos briefs</p>
              <ul className="divide-y divide-rule">{data.briefs.map((b) => (
                <li key={b.id}><button type="button" onClick={() => load(b.id)} className={`flex w-full items-center gap-3 py-2 text-left text-sm hover:text-ink ${open?.id === b.id ? "font-medium" : ""}`}>
                  <span className="min-w-0 flex-1 truncate">{b.title || b.query}</span><span className="shrink-0 text-xs text-muted">{STATUS[b.status] ?? b.status}</span></button></li>))}</ul>
            </div>}
          </div>

          {open ? (
            <section aria-label={`Brief ${open.query}`} className="space-y-4 rounded-xl border border-border bg-raised p-4 text-sm">
              <div>
                <p className="label-caps">Brief</p>
                <h3 className="mt-1 text-base font-medium">« {open.query} »</h3>
                <p className="num text-xs text-muted">{open.data.position == null ? "pas encore classée" : `position ${fmt(open.data.position, 1)}`} · {fmt(open.data.impressions)} impressions sur 90 jours{open.data.page ? ` · page actuelle ${path(open.data.page)}` : ""} · ~{fmt(open.data.length)} mots visés</p>
                {open.data.page && <p className="mt-1 text-xs text-warn">Une page est déjà classée sur cette requête : améliorez-la plutôt que d'en créer une seconde, sinon les deux se concurrenceront.</p>}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><p className="font-medium">Plan proposé</p><p className="mt-1">{open.data.outline.title}</p><ul className="mt-1 list-disc pl-5 text-muted">{open.data.outline.h2.map((h) => <li key={h}>{h}</li>)}</ul></div>
                <div><p className="font-medium">Questions posées</p>{open.data.questions.length ? <ul className="mt-1 list-disc pl-5 text-muted">{open.data.questions.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="mt-1 text-muted">Aucune dans Search Console.</p>}</div>
                <div><p className="font-medium">Expressions voisines</p><p className="mt-1 text-muted">{open.data.related.slice(0, 10).map((x) => x.query).join(", ") || "—"}</p></div>
                <div><p className="font-medium">Liens internes à placer</p>{open.data.links.length ? <ul className="mt-1 text-muted">{open.data.links.map((l) => <li key={l.page} className="truncate">{path(l.page)} <span className="text-xs">({l.query})</span></li>)}</ul> : <p className="mt-1 text-muted">—</p>}</div>
              </div>
              {open.data.competitors.length > 0 && <div><p className="font-medium">Pages concurrentes</p><ul className="mt-1 space-y-1">{open.data.competitors.map((c) => (
                <li key={c.url} className="text-muted"><span className="text-ink">{c.title ?? c.url}</span> · {c.error ? <span className="text-negative">illisible ({c.error})</span> : `${fmt(c.words)} mots, ${c.headings.length} intertitres`}</li>))}</ul></div>}

              <div className="space-y-2 border-t border-rule pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">Article</p>
                  {!demo && (data.ai ? <Button type="button" variant="secondary" disabled={!!busy} onClick={write}>{busy === "draft" ? "Rédaction… (1 à 2 min)" : open.draft ? "Réécrire avec l'IA" : "Rédiger avec l'IA"}</Button>
                    : <span className="text-xs text-muted">Connectez une IA (Connexions → Intelligence artificielle) pour le faire rédiger, ou écrivez-le ci-dessous.</span>)}
                </div>
                <input aria-label="Titre de l'article" value={open.title ?? ""} onChange={(e) => setOpen({ ...open, title: e.target.value })} className={inputCls} readOnly={demo} />
                <textarea aria-label="Texte de l'article" rows={14} value={open.draft ?? ""} onChange={(e) => setOpen({ ...open, draft: e.target.value })} className={`${inputCls} h-auto py-2 font-mono text-xs`} readOnly={demo} placeholder="## Intertitre&#10;Votre texte…" />
                <p className="text-xs text-muted">Relisez : vérifiez chaque chiffre et complétez les passages marqués [à compléter].</p>
                {!demo && <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" disabled={!!busy} onClick={save}>Enregistrer</Button>
                  {data.wordpress && <Button type="button" disabled={!!busy || !open.draft?.trim()} onClick={send}>{busy === "wp" ? "Envoi…" : "Envoyer en brouillon WordPress"}</Button>}
                  {open.wp_link && <a href={open.wp_link} target="_blank" rel="noreferrer" className="text-accent underline">Ouvrir dans WordPress</a>}
                </div>}
              </div>
            </section>
          ) : <EmptyBox>Choisissez un sujet ou indiquez une requête : le brief rassemble ce que Google montre déjà de votre site sur ce sujet.</EmptyBox>}
        </div>
      )}
    </Card>
  );
}
