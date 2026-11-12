// Agents IA : une clé par agent (Claude Code, Codex, OpenCode, Hermes…), la portée projet par projet,
// la commande pour le brancher, et le journal de ce qu'il fait.
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { Header, useData } from "./App";
import { Button, Card, Pill, Table, inputCls, copyText, useAsk } from "./ui";

type Scope = { project_id: string; name: string; mode: "read" | "write" };
type Key = { id: string; name: string; read_only: number; all_projects: number; created_at: number; last_used: number | null; scopes: Scope[] };
type ProjectLite = { id: string; name: string };
type Log = { ts: number; agent: string; tool: string; args: string | null; ok: number; error: string | null };
const when = (t: number | null) => t ? new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais";
const AGENTS = ["Claude Code", "Codex", "OpenCode", "Hermes", "Générique"] as const;

/** Configuration à coller pour chaque agent : le serveur MCP de Searchtide avec la clé dans l'en-tête Authorization. */
export function setupFor(agent: string, url: string, key: string) {
  const id = "searchtide";
  if (agent === "Claude Code") return { where: "Dans un terminal", code: `claude mcp add --scope user --transport http ${id} ${url} --header "Authorization: Bearer ${key}"` };
  if (agent === "Codex") return { where: "Dans ~/.codex/config.toml", code: `[mcp_servers.${id}]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${key}" }` };
  if (agent === "OpenCode") return { where: "Dans ~/.config/opencode/opencode.json(c), sous mcp.servers", code: JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { servers: { [id]: { type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${key}` } } } } }, null, 2) };
  if (agent === "Hermes") return { where: "Dans ~/.hermes/config.yaml, sous mcp_servers:", code: `  ${id}:\n    url: ${url}\n    headers:\n      Authorization: "Bearer ${key}"\n    enabled: true` };
  // Client quelconque : transport Streamable HTTP, URL et en-tête ; exemple au format « mcpServers » courant
  return { where: "Tout client MCP « Streamable HTTP » : URL et en-tête Authorization", code: `URL : ${url}\nEn-tête : Authorization: Bearer ${key}\n\n${JSON.stringify({ mcpServers: { [id]: { type: "http", url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)}` };
}

export function AgentsView() {
  const { ask, dialog } = useAsk();
  const { data: keys, reload } = useData<Key[]>("/api/agents");
  const { data: projects } = useData<ProjectLite[]>("/api/projects");
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const { data: log, reload: reloadLog } = useData<Log[]>(`/api/agents/log?limit=200${filter ? `&agent=${encodeURIComponent(filter)}` : ""}`);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const url = `${location.origin}/mcp`;

  async function revoke(k: Key) {
    if ((await ask({ title: `Révoquer la clé de ${k.name} ?`, message: "L'agent ne pourra plus accéder à Searchtide.", confirmLabel: "Révoquer" })) === null) return;
    await api(`/api/agents/${k.id}`, { method: "DELETE" }); reload();
  }

  return (
    <>
      {dialog}
      <Header title="Agents IA" sub="Chaque agent a sa clé, avec une portée explicite par projet. Lecture seule par défaut : il peut proposer une modification, pas l'exécuter." />
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card title="Clés des agents">
            <Table rows={keys ?? []} empty="Aucune clé pour l'instant : créez-en une par agent." cols={[
              { label: "Agent", className: "w-1/4", render: (k) => k.name },
              { label: "Droits", render: (k) => k.read_only ? <Pill>Lecture seule</Pill> : <Pill tone="positive">Complet</Pill> },
              { label: "Portée", render: (k) => <ScopeSummary k={k} /> },
              { label: "Dernier appel", num: true, render: (k) => when(k.last_used) },
              {
                label: "", num: true, render: (k) => (
                  <span className="flex items-center justify-end gap-3">
                    <button onClick={() => setEditing(editing === k.id ? null : k.id)} className="text-muted hover:text-ink hover:underline">{editing === k.id ? "Fermer" : "Portée"}</button>
                    <button onClick={() => revoke(k)} className="text-negative hover:underline">Révoquer</button>
                  </span>
                ),
              },
            ]} />
            {editing && keys?.find((k) => k.id === editing) && (
              <ScopeEditor key={editing} k={keys.find((k) => k.id === editing)!} projects={projects ?? []}
                onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
            )}
          </Card>
          <Card title="Créer une clé">
            <NewKey projects={projects ?? []} url={url} onCreated={(k) => { setCreated(k); reload(); }} />
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
        <p className="text-xs text-muted">
          Limite connue : un jeton placé dans un segment de chemin d'URL (ex. /api/<span className="font-mono">jeton</span>/stats) n'est pas détectable. Utilisez une connexion API JSON pour ce cas.
        </p>
      </div>
    </>
  );
}

function ScopeSummary({ k }: { k: Key }) {
  if (k.all_projects) return <span className="text-negative" title="Accès à tous les projets, y compris ceux créés plus tard">Tous les projets</span>;
  if (!k.scopes.length) return <span className="text-muted">Aucun projet</span>;
  const read = k.scopes.filter((s) => s.mode === "read").length;
  return <span title={k.scopes.map((s) => `${s.name} (${s.mode === "read" ? "lecture" : "écriture"})`).join(", ")}>
    {k.scopes.length} projet{k.scopes.length > 1 ? "s" : ""}{read && read < k.scopes.length ? ` · ${k.scopes.length - read} en écriture` : read === k.scopes.length ? " · lecture" : ""}
  </span>;
}

/** Choix explicite à la création : tous les projets (averti) ou une sélection, lecture seule par défaut. */
function NewKey({ projects, url, onCreated }: { projects: ProjectLite[]; url: string; onCreated: (k: { name: string; key: string }) => void }) {
  const [readOnly, setReadOnly] = useState(true);
  const [mode, setMode] = useState<"all" | "some">("some");
  const [chosen, setChosen] = useState<Record<string, "read" | "write">>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = Object.keys(chosen);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (mode === "some" && !selected.length) { setError("Choisissez au moins un projet, ou cochez « Tous les projets »."); return; }
    setBusy(true); setError("");
    try {
      const k = await api<{ name: string; key: string }>("/api/agents", {
        method: "POST",
        json: {
          name: f.get("name"), read_only: readOnly,
          all_projects: mode === "all",
          scopes: mode === "some" ? selected.map((id) => ({ project_id: id, mode: readOnly ? "read" : chosen[id] })) : undefined,
        },
      });
      onCreated({ name: k.name, key: k.key });
      setChosen({});
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={create} className="space-y-3 text-sm">
      <label className="block">Nom de l'agent
        <input name="name" required list="agent-names" placeholder="Claude Code, Codex, OpenCode, Hermes…" className={`${inputCls} mt-1`} />
        <datalist id="agent-names">{AGENTS.map((a) => <option key={a} value={a} />)}</datalist>
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="size-4" />Lecture seule (recommandé)</label>
      <p className="text-xs text-muted">{readOnly ? "Cette clé peut proposer une modification ; elle ne peut pas l'exécuter : l'administrateur doit l'approuver." : "Cette clé peut écrire dans les projets de sa portée."}</p>

      <fieldset className="space-y-2">
        <legend className="mb-1">Portée</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="scope" checked={mode === "some"} onChange={() => setMode("some")} className="mt-1" />
          <span>Projets choisis{selected.length ? ` (${selected.length})` : ""}</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="scope" checked={mode === "all"} onChange={() => setMode("all")} className="mt-1" />
          <span>Tous les projets <span className="text-negative">— avertissement : accès à tous les projets, y compris ceux créés plus tard</span></span>
        </label>
      </fieldset>

      {mode === "some" && (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
          {!projects.length && <p className="px-1 py-2 text-muted">Aucun projet pour l'instant.</p>}
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-raised">
              <input type="checkbox" className="size-4" checked={p.id in chosen}
                onChange={(e) => setChosen((c) => {
                  const next = { ...c };
                  if (e.target.checked) next[p.id] = readOnly ? "read" : "read";
                  else delete next[p.id];
                  return next;
                })} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <select aria-label={`Droits sur ${p.name}`} disabled={!readOnly && !(p.id in chosen)}
                value={readOnly ? "read" : chosen[p.id] ?? "read"}
                onChange={(e) => setChosen((c) => ({ ...c, [p.id]: e.target.value as "read" | "write" }))}
                className="h-8 rounded-lg border border-control bg-raised px-2 text-xs disabled:opacity-50">
                <option value="read">Lecture</option>
                {!readOnly && <option value="write">Écriture</option>}
              </select>
            </label>
          ))}
        </div>
      )}

      {error && <p role="alert" className="text-negative">{error}</p>}
      <Button disabled={busy}>{busy ? "Création…" : "Créer la clé"}</Button>
      <p className="text-xs text-muted">La clé ne s'affiche qu'une fois. {url.startsWith("https") ? "" : "Adresse locale : utilisez l'adresse publique pour un agent hors de ce PC."}</p>
    </form>
  );
}

/** Modification de la portée d'une clé existante : tous projets ou sélection, lecture/écriture par projet. */
function ScopeEditor({ k, projects, onClose, onSaved }: { k: Key; projects: ProjectLite[]; onClose: () => void; onSaved: () => void }) {
  const [all, setAll] = useState(!!k.all_projects);
  const [chosen, setChosen] = useState<Record<string, "read" | "write">>(() => Object.fromEntries(k.scopes.map((s) => [s.project_id, s.mode])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const readOnly = !!k.read_only;

  async function save() {
    setBusy(true); setError("");
    try {
      await api(`/api/agents/${k.id}/scopes`, {
        method: "PUT",
        json: { all_projects: all, projects: Object.entries(chosen).map(([project_id, mode]) => ({ project_id, mode: readOnly ? "read" : mode })) },
      });
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded-xl border border-border bg-raised/40 p-3" role="group" aria-label={`Portée de ${k.name}`}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm">Portée de <strong>{k.name}</strong>{readOnly && <span className="text-muted"> · lecture seule</span>}</p>
        <button onClick={onClose} className="text-sm text-muted hover:text-ink">Fermer</button>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="mt-0.5" />
        <span>Tous les projets <span className="text-negative">— avertissement : y compris ceux créés plus tard</span></span>
      </label>
      {!all && (
        <div className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border bg-surface p-2">
          {!projects.length && <p className="px-1 py-2 text-muted">Aucun projet.</p>}
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-raised">
              <input type="checkbox" className="size-4" checked={p.id in chosen}
                onChange={(e) => setChosen((c) => { const n = { ...c }; if (e.target.checked) n[p.id] = "read"; else delete n[p.id]; return n; })} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <select aria-label={`Droits sur ${p.name}`} disabled={readOnly || !(p.id in chosen)}
                value={chosen[p.id] ?? "read"} onChange={(e) => setChosen((c) => ({ ...c, [p.id]: e.target.value as "read" | "write" }))}
                className="h-8 rounded-lg border border-control bg-raised px-2 text-xs disabled:opacity-50">
                <option value="read">Lecture</option>
                <option value="write">Écriture</option>
              </select>
            </label>
          ))}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-negative">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={save} disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer la portée"}</Button>
        <Button variant="secondary" onClick={onClose}>Annuler</Button>
      </div>
    </div>
  );
}

function Setup({ name, url, k, onClose }: { name: string; url: string; k: string; onClose: () => void }) {
  const known = AGENTS.find((a) => name.toLowerCase().includes(a.toLowerCase().split(" ")[0]));
  const [agent, setAgent] = useState<string>(known ?? "Claude Code");
  const s = setupFor(agent, url, k);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(false);
  return (
    <Card title={`Clé de ${name}`} action={<button onClick={onClose} className="text-sm text-muted hover:text-ink">J'ai copié, fermer</button>}>
      <p className="text-sm text-negative">Cette clé ne s'affichera plus : copiez la configuration maintenant.</p>
      <div className="mt-3 flex flex-wrap gap-2">{AGENTS.map((a) => <button key={a} onClick={() => setAgent(a)} aria-pressed={agent === a} className={`h-8 rounded-full px-3 text-sm ${agent === a ? "bg-active text-ink" : "text-muted hover:text-ink"}`}>{a}</button>)}</div>
      <p className="mt-3 text-sm text-muted">{s.where}</p>
      <div className="mt-2 flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-border bg-raised px-3 py-2.5 font-mono text-xs leading-5"><code>{s.code}</code></pre>
        <Button variant="secondary" onClick={async () => { const ok = await copyText(s.code); setDone(ok); setErr(!ok); setTimeout(() => { setDone(false); setErr(false); }, 1500); }}>{done ? "Copié" : "Copier"}</Button>
        {err && <span role="status" className="text-xs text-negative">Copie impossible : sélectionnez le texte.</span>}
      </div>
      <p className="mt-3 text-xs text-muted">Ensuite, demandez à l'agent : « Utilise Searchtide : fais-moi le point sur mes projets, mes indicateurs et mes scores. »</p>
    </Card>
  );
}
