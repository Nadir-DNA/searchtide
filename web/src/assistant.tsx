// Panneau « Demander » (plan B2) : questions sur vos données, réponses de l'IA connectée, avec les sources lues.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { Button, inputCls } from "./ui";
import { Sheet } from "./modules/shared";

type Turn = { role: "user" | "assistant"; content: string; used?: { name: string; error?: string }[]; error?: boolean };
type Conn = { id: string; label: string; provider: string; model: string };
const SOURCE: Record<string, string> = {
  portfolio_overview: "vue d'ensemble", today: "À traiter", alerts: "alertes", search_stats: "Search Console", traffic_stats: "visites", seo_opportunities: "opportunités SEO",
  keywords_tracked: "mots-clés suivis", seo_insights: "diagnostics SEO", seo_audit_issues: "audit technique", indexing_status: "indexation", social_stats: "réseaux sociaux",
  projects_kpis: "indicateurs", crm_list_contacts: "contacts", pubs_list: "publications", list_sites: "sites", page_check: "vérification de page", pub_rules: "règles de seuil",
};
const IDEAS = ["Pourquoi mon trafic Google baisse ce mois-ci ?", "Quel projet demande mon attention en priorité ?", "Quelle publication a le mieux marché sur 30 jours ?", "Quelles pages dois-je améliorer en premier ?"];

export function AssistantPanel({ onClose, project }: { onClose: () => void; project?: string }) {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [conn, setConn] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => { try { return JSON.parse(sessionStorage.getItem("st-assistant") ?? "[]"); } catch { return []; } });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { api<{ connections: Conn[] }>("/api/assistant").then((r) => { setConns(r.connections); setConn(r.connections[0]?.id ?? ""); }).catch(() => setConns([])); }, []);
  useEffect(() => { try { sessionStorage.setItem("st-assistant", JSON.stringify(turns.slice(-20))); } catch { /* stockage indisponible */ } end.current?.scrollIntoView({ block: "end" }); }, [turns]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: text.trim() }];
    setTurns(next); setQ(""); setBusy(true);
    try {
      const r = await api<{ answer: string; used: { name: string; error?: string }[] }>("/api/assistant", { method: "POST", json: { connection_id: conn || undefined, project, messages: next.filter((t) => !t.error).map(({ role, content }) => ({ role, content })) } });
      setTurns([...next, { role: "assistant", content: r.answer, used: r.used }]);
    } catch (e) { setTurns([...next, { role: "assistant", content: (e as Error).message, error: true }]); }
    setBusy(false);
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void send(q); };

  return (
    <Sheet title="Demander" onClose={onClose}>
      {conns && !conns.length ? (
        <div className="rounded-xl border border-border bg-surface p-4 text-sm">
          <p className="font-medium">Aucune IA connectée</p>
          <p className="mt-1 text-muted">Ajoutez votre clé Claude, ChatGPT ou Gemini, ou un modèle local Ollama, dans Connexions → Intelligence artificielle. Les appels sont facturés par le fournisseur, à l'usage.</p>
          <p className="mt-2 text-muted">Vous pouvez aussi brancher votre propre IA (Claude, ChatGPT…) par MCP : Plus → Agents IA.</p>
          <a href="/?view=connections" className="mt-3 inline-block font-semibold text-accent underline">Ouvrir Connexions</a>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted">L'assistant lit vos données (lecture seule) et cite ses sources. Il ne publie ni ne modifie rien.{conns && conns.length > 1 && (
            <select aria-label="IA utilisée" value={conn} onChange={(e) => setConn(e.target.value)} className="ml-2 rounded-lg border border-control bg-raised px-2 py-1 text-ink">{conns.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.model}</option>)}</select>)}</p>
          {!turns.length && <ul className="flex flex-wrap gap-2">{IDEAS.map((i) => <li key={i}><button type="button" onClick={() => send(i)} className="min-h-9 rounded-full border border-control px-3 text-left text-sm hover:bg-raised">{i}</button></li>)}</ul>}
          <div className="space-y-3" aria-live="polite">
            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "ml-8 rounded-xl bg-raised p-3 text-sm" : `rounded-xl border p-3 text-sm ${t.error ? "border-negative/40 text-negative" : "border-border bg-surface"}`}>
                <p className="whitespace-pre-wrap break-words">{t.content}</p>
                {!!t.used?.length && <p className="mt-2 text-xs text-muted">Sources lues : {[...new Set(t.used.filter((u) => !u.error).map((u) => SOURCE[u.name] ?? u.name))].join(", ") || "aucune"}</p>}
              </div>))}
            {busy && <p role="status" className="text-sm text-muted">L'assistant lit vos données…</p>}
            <div ref={end} />
          </div>
          <form onSubmit={submit} className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Votre question…" aria-label="Question" className={inputCls} autoFocus />
            <Button disabled={busy || !q.trim()}>Envoyer</Button>
          </form>
          {!!turns.length && <button type="button" onClick={() => setTurns([])} className="text-xs text-muted underline">Nouvelle conversation</button>}
        </>
      )}
    </Sheet>
  );
}
