// Visibilité dans les IA (plan B5) : questions types, part des réponses qui citent le projet, concurrents cités à côté.
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useData } from "./App";
import { Button, Card, EmptyBox, inputCls } from "./ui";

type Point = { week: string; share: number | null; answers: number; rank: number | null };
type Report = {
  week: string | null; weeks: string[]; connected: number;
  models: { provider: string; label: string; model: string; series: Point[]; last: Point | null }[];
  prompts: { id: string; question: string; answers: { provider: string; model: string; cited: boolean | null; rank: number | null; competitors: string[]; error: string | null; answer: string | null }[] }[];
  brand: { brand: string[]; competitors: string[] }; rivals: { name: string; n: number }[];
};
const IDEAS = ["Quel est le meilleur outil pour … ?", "Quelle entreprise choisir pour … à … ?", "Que penses-tu de … ?"];

/** Barres de part de citation par semaine : décoratives, la valeur est écrite. */
function Bars({ series }: { series: Point[] }) {
  return <div className="flex h-10 items-end gap-1" aria-hidden>{series.map((p) => <span key={p.week} title={`${p.week} : ${p.share ?? "—"} %`} className={`w-3 rounded-sm ${p.share == null ? "bg-rule" : "bg-accent"}`} style={{ height: `${Math.max(p.share ?? 4, 4)}%` }} />)}</div>;
}

export function VisibilityView({ projectId }: { projectId: string }) {
  const { data, reload } = useData<Report>(`/api/projects/${projectId}/ai-visibility`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); reload(); } catch (e) { setError((e as Error).message); } };
  const add = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = e.currentTarget; const q = String(new FormData(f).get("question") ?? ""); void act(async () => { await api(`/api/projects/${projectId}/ai-prompts`, { method: "POST", json: { question: q } }); f.reset(); }); };
  const brand = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(() => api(`/api/projects/${projectId}/ai-brand`, { method: "PUT", json: { names: f.get("names"), competitors: f.get("competitors") } })); };
  const run = async () => { setBusy(true); await act(() => api(`/api/projects/${projectId}/ai-visibility/run`, { method: "POST" })); setBusy(false); };
  if (!data) return <p className="text-sm text-muted">Chargement…</p>;

  return (
    <div className="space-y-4">
      <Card title="Visibilité dans les IA" action={data.connected > 0 && data.prompts.length > 0 && <Button variant="secondary" disabled={busy} onClick={run}>{busy ? "Questions en cours…" : "Poser les questions maintenant"}</Button>}>
        <p className="mb-3 text-sm text-muted">Chaque semaine, vos questions types sont posées à chaque IA connectée. On relève si votre projet est cité, à quelle place et qui l'est à côté. Les réponses varient d'une fois à l'autre : lisez la tendance. Les modèles répondent de mémoire, sans recherche web.</p>
        {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
        {!data.connected ? <EmptyBox>Aucune IA connectée : ajoutez vos clés Claude, ChatGPT ou Gemini dans Connexions → Intelligence artificielle (une connexion par IA à suivre). Coût : quelques centimes par semaine pour 20 questions.</EmptyBox>
          : !data.models.length ? <EmptyBox>Pas encore de mesure : ajoutez des questions ci-dessous, puis posez-les.</EmptyBox> : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{data.models.map((m) => (
            <div key={m.provider + m.model} className="rounded-xl border border-border bg-raised p-4">
              <p className="label-caps">{m.label}</p>
              <p className="mt-1 kpi text-[28px]">{m.last?.share == null ? "—" : `${m.last.share} %`}</p>
              <p className="text-xs text-muted">des réponses vous citent{m.last ? ` · semaine ${m.last.week.slice(-3)} · ${m.last.answers} réponse${m.last.answers > 1 ? "s" : ""}` : ""}{m.last?.rank != null ? ` · place moyenne ${m.last.rank}` : ""}</p>
              <div className="mt-3"><Bars series={m.series} /></div>
              <p className="mt-1 truncate text-[11px] text-muted">{m.model}</p>
            </div>))}</div>)}
        {data.rivals.length > 0 && <p className="mt-4 text-sm"><span className="text-muted">Cités à côté de vous : </span>{data.rivals.map((r) => `${r.name} (${r.n})`).join(", ")}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Questions types">
          <form onSubmit={add} className="mb-3 flex gap-2"><input name="question" required minLength={8} placeholder={IDEAS[0]} aria-label="Nouvelle question" className={inputCls} /><Button variant="secondary">Ajouter</Button></form>
          <p className="mb-3 text-xs text-muted">Posez-les comme vos clients : « {IDEAS.join(" » · « ")} ». 20 au plus.</p>
          {data.prompts.length ? <ul className="divide-y divide-rule">{data.prompts.map((p) => (
            <li key={p.id} className="py-2 text-sm">
              <div className="flex items-start gap-2">
                <button type="button" onClick={() => setOpen(open === p.id ? null : p.id)} className="min-w-0 flex-1 text-left hover:text-ink" aria-expanded={open === p.id}>{p.question}</button>
                <span className="flex shrink-0 gap-1">{p.answers.map((a) => <span key={a.provider + a.model} title={`${a.provider} : ${a.error ? "erreur" : a.cited ? `cité, place ${a.rank}` : "non cité"}`} className={`led ${a.error ? "led-off" : a.cited ? "led-ok" : "led-bad"}`} />)}</span>
                <button type="button" onClick={() => act(() => api(`/api/projects/${projectId}/ai-prompts/${p.id}`, { method: "DELETE" }))} className="shrink-0 text-xs text-negative hover:underline">Retirer</button>
              </div>
              {open === p.id && <div className="mt-2 space-y-2">{p.answers.length ? p.answers.map((a) => (
                <div key={a.provider + a.model} className="rounded-lg bg-raised p-2 text-xs">
                  <p className="font-medium">{a.provider} · {a.error ? <span className="text-negative">{a.error}</span> : a.cited ? <span className="text-positive">cité, place {a.rank}</span> : <span className="text-negative">non cité</span>}{a.competitors.length ? <span className="font-normal text-muted"> · {a.competitors.join(", ")}</span> : null}</p>
                  {a.answer && <p className="mt-1 whitespace-pre-wrap text-muted">{a.answer}</p>}
                </div>)) : <p className="text-xs text-muted">Pas encore posée cette semaine.</p>}</div>}
            </li>))}</ul> : <EmptyBox>Aucune question.</EmptyBox>}
        </Card>
        <Card title="Comment on vous reconnaît">
          <form onSubmit={brand} className="space-y-3">
            <p className="text-sm text-muted">Le nom du projet et ses domaines sont toujours cherchés. Ajoutez vos autres noms (marque, produit) et vos concurrents, séparés par des virgules.</p>
            <label className="block text-sm"><span className="text-muted">Autres noms</span><input name="names" defaultValue={data.brand.brand.join(", ")} className={`${inputCls} mt-1.5`} /></label>
            <label className="block text-sm"><span className="text-muted">Concurrents</span><input name="competitors" defaultValue={data.brand.competitors.join(", ")} className={`${inputCls} mt-1.5`} /></label>
            <Button variant="secondary">Enregistrer</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
