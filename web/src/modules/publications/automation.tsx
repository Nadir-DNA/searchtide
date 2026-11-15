// Automatisations (plan D5, D10) : flux RSS qui créent des publications, webhooks sortants signés.
import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { useData } from "../../App";
import { Button, Card, copyText, inputCls, useAsk } from "../../ui";

type Account = { id: string; label: string; network: string };
type Feed = { id: string; url: string; accounts: string; mode: string; template: string; checked_at: number | null; error: string | null };
type Hook = { id: string; url: string; events: string; last_status: number | null; last_error: string | null; last_at: number | null };
const EVENTS: [string, string][] = [["published", "Publiée"], ["failed", "Échec"], ["to_verify", "À vérifier"], ["needs_action", "Action requise"]];

export function AutomationCard() {
  const { ask, dialog } = useAsk();
  const { data: accounts } = useData<Account[]>("/api/pub-accounts");
  const { data: feeds, reload: reloadFeeds } = useData<Feed[]>("/api/rss-feeds");
  const { data: hooks, reload: reloadHooks } = useData<Hook[]>("/api/webhooks");
  const [picked, setPicked] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>(EVENTS.map(([k]) => k));
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const name = (id: string) => accounts?.find((a) => a.id === id)?.label ?? "compte retiré";

  async function addFeed(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    const f = new FormData(e.currentTarget);
    try { await api("/api/rss-feeds", { method: "POST", json: { url: f.get("url"), template: f.get("template"), mode: f.get("mode"), accounts: picked } }); (e.target as HTMLFormElement).reset(); setPicked([]); reloadFeeds(); }
    catch (err) { setError((err as Error).message); }
  }
  async function addHook(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    const f = new FormData(e.currentTarget);
    try { const r = await api<{ secret: string }>("/api/webhooks", { method: "POST", json: { url: f.get("url"), events } }); setSecret(r.secret); (e.target as HTMLFormElement).reset(); reloadHooks(); }
    catch (err) { setError((err as Error).message); }
  }
  const remove = async (kind: "rss-feeds" | "webhooks", id: string, label: string) => {
    if ((await ask({ title: `Supprimer ${label} ?`, confirmLabel: "Supprimer" })) === null) return;
    await api(`/api/${kind}/${id}`, { method: "DELETE" }); kind === "rss-feeds" ? reloadFeeds() : reloadHooks();
  };

  return (
    <Card title="Automatisations">
      {dialog}
      {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
      <div className="grid gap-8 xl:grid-cols-2">
        <section aria-labelledby="auto-rss">
          <h3 id="auto-rss" className="font-medium">Publier depuis un flux RSS</h3>
          <p className="mb-3 text-sm text-muted">Chaque nouvel article de votre blog ou newsletter crée une publication par compte choisi. Vérifié toutes les heures ; les articles déjà parus ne sont pas repris.</p>
          <form onSubmit={addFeed} className="space-y-3">
            <input name="url" type="url" required placeholder="https://monblog.fr/feed.xml" aria-label="Adresse du flux" className={inputCls} />
            <input name="template" defaultValue="{titre} {lien}" aria-label="Modèle du texte" className={inputCls} />
            <p className="text-xs text-muted">Le modèle accepte {"{titre}"} et {"{lien}"}.</p>
            <div className="flex flex-wrap gap-2">{(accounts ?? []).map((a) => (
              <label key={a.id} className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm ${picked.includes(a.id) ? "border-accent" : "border-control"}`}>
                <input type="checkbox" checked={picked.includes(a.id)} onChange={() => setPicked(picked.includes(a.id) ? picked.filter((x) => x !== a.id) : [...picked, a.id])} className="size-4 accent-[var(--color-accent)]" />{a.label}<span className="text-xs text-muted">{a.network}</span>
              </label>))}</div>
            <div className="flex flex-wrap items-center gap-3">
              <select name="mode" aria-label="Que faire des nouveaux articles" className={`${inputCls} w-auto`}><option value="draft">Créer des brouillons à relire</option><option value="now">Publier tout de suite</option></select>
              <Button disabled={!picked.length}>Ajouter le flux</Button>
            </div>
          </form>
          <ul className="mt-4 divide-y divide-rule">{(feeds ?? []).map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span aria-hidden className={`led ${f.error ? "led-bad" : f.checked_at ? "led-ok" : "led-off"}`} />
              <span className="min-w-0 flex-1 truncate">{f.url}</span>
              <span className="text-xs text-muted">{(JSON.parse(f.accounts) as string[]).map(name).join(", ")} · {f.mode === "now" ? "publication directe" : "brouillons"}</span>
              {f.error && <span className="w-full pl-[18px] text-xs text-negative">{f.error}</span>}
              <button type="button" onClick={() => remove("rss-feeds", f.id, "ce flux")} className="text-xs text-negative hover:underline">Supprimer</button>
            </li>))}</ul>
        </section>

        <section aria-labelledby="auto-hooks">
          <h3 id="auto-hooks" className="font-medium">Webhooks</h3>
          <p className="mb-3 text-sm text-muted">Prévenez n8n, Zapier, votre CMS ou votre CI quand une publication change d'état. Chaque appel est signé : en-tête <code className="font-mono">x-searchtide-signature</code> (HMAC-SHA256 du corps).</p>
          <form onSubmit={addHook} className="space-y-3">
            <input name="url" type="url" required placeholder="https://n8n.monsite.fr/webhook/…" aria-label="Adresse du webhook" className={inputCls} />
            <div className="flex flex-wrap gap-3">{EVENTS.map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={events.includes(k)} onChange={() => setEvents(events.includes(k) ? events.filter((x) => x !== k) : [...events, k])} className="size-4 accent-[var(--color-accent)]" />{l}</label>))}</div>
            <Button disabled={!events.length}>Ajouter le webhook</Button>
          </form>
          {secret && (
            <div role="status" className="mt-3 rounded-xl border border-border bg-raised p-3 text-sm">
              <p className="font-medium">Secret de signature (affiché une seule fois)</p>
              <p className="mt-1 font-mono text-xs break-all">{secret}</p>
              <Button className="mt-2" variant="secondary" onClick={async () => { await copyText(secret); setSecret(""); }}>Copier et masquer</Button>
            </div>
          )}
          <ul className="mt-4 divide-y divide-rule">{(hooks ?? []).map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span aria-hidden className={`led ${h.last_error ? "led-bad" : h.last_status ? "led-ok" : "led-off"}`} />
              <span className="min-w-0 flex-1 truncate">{h.url}</span>
              <span className="text-xs text-muted">{(JSON.parse(h.events) as string[]).map((e) => EVENTS.find(([k]) => k === e)?.[1] ?? e).join(", ")}{h.last_status ? ` · dernière réponse ${h.last_status}` : ""}</span>
              {h.last_error && <span className="w-full pl-[18px] text-xs text-negative">{h.last_error}</span>}
              <button type="button" onClick={() => remove("webhooks", h.id, "ce webhook")} className="text-xs text-negative hover:underline">Supprimer</button>
            </li>))}</ul>
        </section>
      </div>
    </Card>
  );
}
