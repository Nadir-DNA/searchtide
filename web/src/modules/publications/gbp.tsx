// Fiches Google (plan A8) : note, avis et réponses, vues, appels, itinéraires et clics vers le site.
import { useState } from "react";
import { api } from "../../api";
import { useData } from "../../App";
import { Button, Card, Delta, EmptyBox, fmt, inputCls } from "../../ui";

type Review = { review_id: string; author: string; rating: number | null; comment: string | null; created_at: string | null; reply: string | null };
type Actions = { views: number; calls: number; directions: number; website: number } | null;
type Loc = { id: string; label: string; connected: boolean; rating: number | null; total: number | null; error: string | null; actions: Actions; previous: Actions; unanswered: number; reviews: Review[] };

function ReviewItem({ loc, r, onDone }: { loc: Loc; r: Review; onDone: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError((e as Error).message); } setBusy(false); };
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2"><span className="font-medium">{r.author}</span>
        <span className={`num text-xs font-semibold ${Number(r.rating) <= 3 ? "text-negative" : "text-positive"}`} aria-label={`${r.rating} sur 5`}>{"★".repeat(r.rating ?? 0)}<span className="text-muted">{"★".repeat(5 - (r.rating ?? 0))}</span></span>
        {r.created_at && <span className="text-xs text-muted">{new Date(r.created_at).toLocaleDateString("fr-FR")}</span>}</div>
      {r.comment && <p className="mt-1 whitespace-pre-wrap">{r.comment}</p>}
      {r.reply && text === null ? <p className="mt-2 border-l-2 border-rule pl-3 text-muted">Votre réponse : {r.reply} <button type="button" onClick={() => setText(r.reply)} className="text-xs underline">Modifier</button></p>
        : text === null ? <div className="mt-2 flex gap-3 text-xs"><button type="button" onClick={() => setText("")} className="font-semibold text-accent hover:underline">Répondre</button>
            <button type="button" disabled={busy} onClick={() => run(async () => setText((await api<{ text: string }>(`/api/gbp/${loc.id}/reviews/${encodeURIComponent(r.review_id)}/draft`, { method: "POST" })).text))} className="text-muted underline">{busy ? "Rédaction…" : "Proposer une réponse (IA)"}</button></div>
        : <div className="mt-2 space-y-2">
            <textarea aria-label={`Réponse à ${r.author}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} h-auto py-2`} />
            <div className="flex gap-2"><Button type="button" disabled={busy || text.trim().length < 2} onClick={() => run(async () => { await api(`/api/gbp/${loc.id}/reviews/${encodeURIComponent(r.review_id)}/reply`, { method: "POST", json: { text } }); setText(null); onDone(); })}>Publier la réponse</Button>
              <Button type="button" variant="secondary" onClick={() => setText(null)}>Annuler</Button></div>
            <p className="text-xs text-muted">La réponse est publique sur Google, sous l'avis.</p>
          </div>}
      {error && <p role="alert" className="mt-1 text-xs text-negative">{error}</p>}
    </li>
  );
}

export function GbpCard({ project }: { project?: string }) {
  const { data, reload } = useData<Loc[]>(`/api/gbp${project ? `?project=${project}` : ""}`);
  const [busy, setBusy] = useState(false);
  if (!data || !data.length) return null;
  const tiles: [string, keyof NonNullable<Actions>][] = [["Vues de la fiche", "views"], ["Appels", "calls"], ["Itinéraires", "directions"], ["Clics vers le site", "website"]];
  return (
    <Card title="Fiches Google" action={<Button variant="secondary" disabled={busy} onClick={async () => { setBusy(true); await api("/api/gbp/refresh", { method: "POST" }).catch(() => {}); reload(); setBusy(false); }}>{busy ? "Relevé…" : "Relever maintenant"}</Button>}>
      <div className="space-y-6">{data.map((l) => (
        <section key={l.id} aria-label={l.label}>
          <div className="mb-3 flex flex-wrap items-baseline gap-3">
            <h3 className="font-medium">{l.label}</h3>
            <span className="kpi text-[22px]">{l.rating == null ? "—" : `${fmt(l.rating, 1)} / 5`}</span>
            <span className="text-sm text-muted">{l.total == null ? "avis non relevés" : `${fmt(l.total)} avis`}{l.unanswered ? ` · ${l.unanswered} sans réponse` : ""}</span>
          </div>
          {l.error && <p role="alert" className="mb-2 text-sm text-negative">{l.error}</p>}
          {l.actions ? <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{tiles.map(([label, k]) => (
            <div key={k} className="rounded-xl border border-border p-3"><p className="label-caps">{label}</p><p className="kpi text-[22px]">{fmt(l.actions![k])}</p><Delta now={l.actions![k]} before={l.previous?.[k] ?? null} /></div>))}</div>
            : <EmptyBox>Actions de la fiche pas encore relevées (Google les publie avec deux jours de retard).</EmptyBox>}
          {l.reviews.length > 0 && <ul className="mt-3 divide-y divide-rule">{l.reviews.map((r) => <ReviewItem key={r.review_id} loc={l} r={r} onDone={reload} />)}</ul>}
        </section>))}</div>
    </Card>
  );
}
