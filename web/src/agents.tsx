// Agents IA : une clé par agent (Claude Code, Codex, OpenCode, Hermes…), la commande pour le brancher, et le journal de ce qu'il fait.
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { Header, useData } from "./App";
import { Button, Card, Pill, Table, inputCls } from "./ui";

type Key = { id: string; name: string; read_only: number; created_at: number; last_used: number | null };
type Log = { ts: number; agent: string; tool: string; args: string | null; ok: number; error: string | null };
const when = (t: number | null) => t ? new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais";
const AGENTS = ["Claude Code", "Codex", "OpenCode", "Hermes"] as const;

/** Configuration à coller pour chaque agent : le serveur MCP de Searchtide avec la clé dans l'en-tête Authorization. */
export function setupFor(agent: string, url: string, key: string) {
  const id = "searchtide";
  if (agent === "Claude Code") return { where: "Dans un terminal", code: `claude mcp add --scope user --transport http ${id} ${url} --header "Authorization: Bearer ${key}"` };
  if (agent === "Codex") return { where: "Dans ~/.codex/config.toml", code: `[mcp_servers.${id}]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${key}" }` };
  if (agent === "OpenCode") return { where: "Dans ~/.config/opencode/opencode.json, clé \"mcp\"", code: JSON.stringify({ mcp: { [id]: { type: "remote", url, enabled: true, headers: { Authorization: `Bearer ${key}` } } } }, null, 2) };
  if (agent === "Hermes") return { where: "Dans ~/.hermes/config.yaml, sous mcp_servers:", code: `  ${id}:\n    url: ${url}\n    headers:\n      Authorization: "Bearer ${key}"\n    enabled: true` };
  return { where: "Tout client MCP (HTTP « streamable »)", code: `URL : ${url}\nEn-tête : Authorization: Bearer ${key}` };
}

export function AgentsView() {
  const { data: keys, reload } = useData<Key[]>("/api/agents");
  const [filter, setFilter] = useState("");
  const { data: log, reload: reloadLog } = useData<Log[]>(`/api/agents/log?limit=200${filter ? `&agent=${encodeURIComponent(filter)}` : ""}`);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState("");
  const url = `${location.origin}/mcp`;

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { setError(""); const k = await api<{ name: string; key: string }>("/api/agents", { method: "POST", json: { name: f.get("name"), read_only: f.get("read_only") === "on" } }); setCreated(k); reload(); e.currentTarget?.reset(); }
    catch (err) { setError((err as Error).message); }
  }
  async function revoke(k: Key) {
    if (!confirm(`Révoquer la clé de ${k.name} ? L'agent ne pourra plus accéder à Searchtide.`)) return;
    await api(`/api/agents/${k.id}`, { method: "DELETE" }); reload();
  }

  return (
    <>
      <Header title="Agents IA" sub="Chaque agent a sa clé : il lit tout Searchtide, range les pages et laisse des notes, et chacun de ses appels est journalisé." />
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card title="Clés des agents">
            <Table rows={keys ?? []} empty="Aucune clé pour l'instant : créez-en une par agent." cols={[
              { label: "Agent", className: "w-1/3", render: (k) => k.name },
              { label: "Droits", render: (k) => k.read_only ? <Pill>Lecture seule</Pill> : <Pill tone="positive">Complet</Pill> },
              { label: "Dernier appel", num: true, render: (k) => when(k.last_used) },
              { label: "", num: true, render: (k) => <button onClick={() => revoke(k)} className="text-negative hover:underline">Révoquer</button> },
            ]} />
          </Card>
          <Card title="Brancher un agent">
            <form onSubmit={create} className="space-y-3 text-sm">
              <label className="block">Nom de l'agent
                <input name="name" required list="agent-names" placeholder="Claude Code, Codex, OpenCode, Hermes…" className={`${inputCls} mt-1`} />
                <datalist id="agent-names">{AGENTS.map((a) => <option key={a} value={a} />)}</datalist>
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" name="read_only" className="size-4" />Lecture seule (ne peut rien modifier)</label>
              {error && <p role="alert" className="text-negative">{error}</p>}
              <Button>Créer la clé</Button>
            </form>
          </Card>
        </div>
        {created && <Setup name={created.name} url={url} k={created.key} onClose={() => setCreated(null)} />}
        <Card title="Journal des agents" action={
          <span className="flex items-center gap-2">
            <select aria-label="Agent" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-9 rounded-lg border border-control bg-raised px-2 text-sm">
              <option value="">Tous les agents</option>{[...new Set([...(keys ?? []).map((k) => k.name), "Clé principale"])].map((n) => <option key={n}>{n}</option>)}
            </select>
            <Button variant="secondary" onClick={reloadLog}>Actualiser</Button>
          </span>}>
          <Table rows={log ?? []} empty="Aucun appel pour l'instant." cols={[
            { label: "Quand", render: (r) => <span className="num text-muted">{when(r.ts)}</span> },
            { label: "Agent", render: (r) => r.agent },
            { label: "Outil", render: (r) => <span className="font-mono text-xs">{r.tool}</span> },
            { label: "Détail", className: "w-1/3", render: (r) => <span className={`font-mono text-xs ${r.ok ? "text-muted" : "text-negative"}`} title={r.error ?? r.args ?? ""}>{r.error ?? r.args ?? ""}</span> },
            { label: "", num: true, render: (r) => r.ok ? <Pill tone="positive">ok</Pill> : <Pill tone="negative">échec</Pill> },
          ]} />
        </Card>
      </div>
    </>
  );
}

function Setup({ name, url, k, onClose }: { name: string; url: string; k: string; onClose: () => void }) {
  const known = AGENTS.find((a) => name.toLowerCase().includes(a.toLowerCase().split(" ")[0]));
  const [agent, setAgent] = useState<string>(known ?? "Claude Code");
  const s = setupFor(agent, url, k);
  const [done, setDone] = useState(false);
  return (
    <Card title={`Clé de ${name}`} action={<button onClick={onClose} className="text-sm text-muted hover:text-ink">J'ai copié, fermer</button>}>
      <p className="text-sm text-negative">Cette clé ne s'affichera plus : copiez la configuration maintenant.</p>
      <div className="mt-3 flex flex-wrap gap-2">{AGENTS.map((a) => <button key={a} onClick={() => setAgent(a)} aria-pressed={agent === a} className={`h-8 rounded-full px-3 text-sm ${agent === a ? "bg-active text-ink" : "text-muted hover:text-ink"}`}>{a}</button>)}</div>
      <p className="mt-3 text-sm text-muted">{s.where}</p>
      <div className="mt-2 flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-border bg-raised px-3 py-2.5 font-mono text-xs leading-5"><code>{s.code}</code></pre>
        <Button variant="secondary" onClick={() => navigator.clipboard.writeText(s.code).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>{done ? "Copié" : "Copier"}</Button>
      </div>
      <p className="mt-3 text-xs text-muted">Ensuite, demandez à l'agent : « Utilise Searchtide : fais-moi le point sur mes projets et range ma page d'accueil. » {!url.startsWith("https") && "Adresse locale : utilisez l'adresse publique pour un agent hors de ce PC."}</p>
    </Card>
  );
}
