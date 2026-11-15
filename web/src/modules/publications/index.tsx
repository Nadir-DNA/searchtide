// Module Publications : bloc de la semaine et calendrier éditorial.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../../App";
import { Button, Card, EmptyBox, Pill, Segmented, Table, fmt, inputCls, copyText, useAsk } from "../../ui";
import { ATTEMPT_LABEL, PUB_CHIP, PUB_STATE } from "../shared";
import { MultiComposer } from "./composer";
import { SocialStatsCard } from "./stats";
import { GbpCard } from "./gbp";
import { VisualsCard } from "./visuals";
import { AutomationCard, RulesCard } from "./automation";
import { type Contact, type Pub, type Summary, type Go, STAGES, type Stage, stageName, KINDS, PUB_STATUS, NETWORKS, NET_LIMIT, NET_NAME, filterCls, eur, today, dateFr, Sheet, Field } from "../shared";

export function PubsCard({ go, title = "Publications de la semaine" }: { go: Go; title?: string }) {
  const { data: s } = useData<Summary>("/api/business");
  return (
    <Card title={title} action={<Button variant="secondary" onClick={() => go({ view: "pubs", id: undefined, site: undefined })}>Calendrier</Button>}>
      {!s ? null : s.pubsWeek.length ? (
        <ul className="divide-y divide-rule">
          {s.pubsWeek.map((p) => (
            <li key={p.id} className="flex h-11 items-center gap-3 text-sm">
              <span className={`num w-20 shrink-0 ${p.day === today() ? "font-medium text-ink" : "text-muted"}`}>{dateFr(p.day, { weekday: "short", day: "numeric" })}</span>
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              <span className="hidden text-muted sm:inline">{[p.project, p.network].filter(Boolean).join(" · ")}</span>
              <StatusPill s={p.status} state={p.state} />
            </li>
          ))}
        </ul>
      ) : <EmptyBox>Rien de prévu cette semaine. <button onClick={() => go({ view: "pubs", id: undefined, site: undefined })} className="text-ink underline">Planifier une publication</button></EmptyBox>}
    </Card>
  );
}

function StatusPill({ s, state }: { s: Pub["status"]; state?: string | null }) {
  // L'état réel (échec, à vérifier, annulée…) prime sur le statut éditorial (Idée / Prévue / Publiée).
  if (state && !["draft", "scheduled", "published"].includes(state)) return <Pill tone="negative">{PUB_STATE[state]?.[0] ?? state}</Pill>;
  return <Pill tone={s === "published" ? "positive" : "neutral"}>{PUB_STATUS.find(([k]) => k === s)?.[1]}</Pill>;
}

// ── Calendrier des publications ──
type ProjectRef = { id: string; name: string; crm_key: string | null; color?: string | null };
/** Clé enregistrée sur les publications et comptes d'un projet (clé CRM si elle existe, comme le reste du module). */
export const projectKey = (p: ProjectRef) => p.crm_key ?? p.id;
const keysOf = (p: ProjectRef) => [p.id, p.crm_key].filter(Boolean) as string[];

/** Calendrier et comptes d'un projet. Dans la page d'un projet, `project` est fixé ; sur la page Publications, un sélecteur le choisit. */
export function PubsView({ q, go, project: fixed }: { q: Record<string, string>; go: Go; project?: ProjectRef }) {
  const { data: projects } = useData<ProjectRef[]>("/api/projects?days=1");
  const current = fixed ?? projects?.find((p) => q.project && keysOf(p).includes(q.project));
  const scope = current ? projectKey(current) : undefined;
  const nameOf = (key: string | null) => projects?.find((p) => key && keysOf(p).includes(key));
  const month = /^\d{4}-\d{2}$/.test(q.month ?? "") ? q.month : today().slice(0, 7);
  const first = new Date(month + "-01T00:00:00Z");
  const start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 86400000);
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
  const { data, error, reload } = useData<Pub[]>(`/api/publications?from=${days[0]}&to=${days[41]}${scope ? `&project=${encodeURIComponent(scope)}` : ""}`);
  const [edit, setEdit] = useState<Partial<Pub> | null>(null);
  const [multi, setMulti] = useState(false);
  const shift = (n: number) => { const d = new Date(first); d.setUTCMonth(d.getUTCMonth() + n); go({ month: d.toISOString().slice(0, 7) }); };
  const byDay = useMemo(() => (data ?? []).reduce<Record<string, Pub[]>>((m, p) => ((m[p.day] ??= []).push(p), m), {}), [data]);
  const counts = { published: data?.filter((p) => p.day.startsWith(month) && p.status === "published").length ?? 0, planned: data?.filter((p) => p.day.startsWith(month) && p.status !== "published").length ?? 0 };
  return (
    <>
      {(() => {
        const sub = `${dateFr(month + "-01", { month: "long", year: "numeric" })} · ${counts.published} publiées, ${counts.planned} prévues`;
        const buttons = <>
        <Button variant="secondary" onClick={() => shift(-1)} aria-label="Mois précédent">←</Button>
        <Button variant="secondary" onClick={() => go({ month: undefined })}>Aujourd'hui</Button>
        <Button variant="secondary" onClick={() => shift(1)} aria-label="Mois suivant">→</Button>
        <Button variant="secondary" onClick={() => setMulti(true)}>Plusieurs comptes</Button>
        <Button onClick={() => setEdit({ day: today(), status: "scheduled", project: scope ?? null })}>Nouvelle publication</Button>
        </>;
        // Dans la page d'un projet, son en-tête existe déjà : une barre d'outils suffit.
        return fixed ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">{sub}</p><div className="flex flex-wrap gap-2">{buttons}</div></div>
          : <Header title={current ? `Publications · ${current.name}` : "Publications"} sub={sub}>{buttons}</Header>;
      })()}
      {!fixed && (projects?.length ?? 0) > 1 && (
        <div className="no-scrollbar -mt-2 mb-4 flex gap-2 overflow-x-auto" role="group" aria-label="Projet affiché">
          {[{ key: "", label: "Tous les projets", color: null as string | null | undefined }, ...(projects ?? []).map((p) => ({ key: projectKey(p), label: p.name, color: p.color }))].map((o) => {
            const on = (o.key || undefined) === scope;
            return <button key={o.key || "tous"} type="button" aria-pressed={on} onClick={() => go({ project: o.key || undefined })}
              className={`inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm ${on ? "border-accent bg-raised font-medium" : "border-control text-muted hover:text-ink"}`}>
              {o.color && <span aria-hidden className="size-2 rounded-full" style={{ background: o.color }} />}{o.label}</button>;
          })}
        </div>
      )}
      {multi && <MultiComposer onClose={() => setMulti(false)} onSaved={reload} project={current ? keysOf(current) : undefined} />}
      {error ? <ErrorLine error={error} retry={reload} /> : !data ? <KpiSkeleton /> : (
        <>
          <div className="hidden overflow-hidden rounded-2xl border border-border bg-surface md:block">
            <div className="grid grid-cols-7 border-b border-border text-xs text-muted">
              {["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."].map((d) => <div key={d} className="px-3 py-2">{d}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d) => (
                <div key={d} onDoubleClick={() => setEdit({ day: d, status: "scheduled" })}
                  className={`min-h-28 border-r border-b border-rule p-2 [&:nth-child(7n)]:border-r-0 ${d.startsWith(month) ? "" : "bg-ground"}`}>
                  <div className={`num mb-1 text-xs ${d === today() ? "inline-grid size-6 place-items-center rounded-full bg-accent text-on-accent" : "text-muted"}`}>{Number(d.slice(8))}</div>
                  <div className="space-y-1">
                    {byDay[d]?.map((p) => (
                      <button key={p.id} onClick={() => setEdit(p)} title={p.title}
                        className={`block w-full truncate rounded-lg px-2 py-1 text-left text-xs ${PUB_CHIP[p.state ?? (p.status === "published" ? "published" : "draft")] ?? "bg-raised"}`}>
                        {!scope && nameOf(p.project) && <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: nameOf(p.project)?.color ?? "currentColor" }} />}
                        {p.network && <span className="opacity-70">{p.network} · </span>}{p.title}{p.state && !["published", "draft", "scheduled"].includes(p.state) && <span className="ml-1 font-medium">· {PUB_STATE[p.state]?.[0] ?? p.state}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Card className="md:hidden">
            {data.filter((p) => p.day.startsWith(month)).length ? (
              <ul className="divide-y divide-rule">
                {data.filter((p) => p.day.startsWith(month)).map((p) => (
                  <li key={p.id}><button onClick={() => setEdit(p)} className="flex h-12 w-full items-center gap-3 text-left text-sm">
                    <span className="num w-14 shrink-0 text-muted">{dateFr(p.day)}</span><span className="min-w-0 flex-1 truncate">{p.title}{!scope && nameOf(p.project) ? <span className="text-muted"> · {nameOf(p.project)!.name}</span> : null}</span><StatusPill s={p.status} state={p.state} />
                  </button></li>
                ))}
              </ul>
            ) : <EmptyBox>Rien de prévu ce mois-ci. <button type="button" onClick={() => setEdit({ day: today(), status: "scheduled" })} className="text-ink underline">Planifier une publication</button></EmptyBox>}
          </Card>
          <p className="mt-3 hidden text-xs text-muted md:block">Double-cliquez sur un jour pour y ajouter une publication.</p>
          <div className="mt-4"><AccountsCard project={current} projects={projects ?? []} /></div>
          <div className="mt-4"><SocialStatsCard project={scope} /></div>
          <div className="mt-4"><GbpCard project={scope} /></div>
          <div className="mt-4"><AutomationCard project={current ? keysOf(current) : undefined} /></div>
          <div className="mt-4"><RulesCard project={current ? keysOf(current) : undefined} /></div>
          <div className="mt-4"><VisualsCard project={current} /></div>
        </>
      )}
      {edit && <PubSheet pub={edit} projects={projects ?? []} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

// Lien de suivi : à mettre dans la bio ou la description, il compte les visites amenées par la publication
function TrackingLink({ pub }: { pub: Partial<Pub> }) {
  const { data: sites } = useData<{ domain: string }[]>("/api/sites");
  const [site, setSite] = useState("");
  const [path, setPath] = useState("/");
  const [copied, setCopied] = useState(false);
  const [copyErr, setCopyErr] = useState(false);
  const domain = site || sites?.find((s) => pub.project && s.domain.replace(/[^a-z]/g, "").includes(pub.project.replace(/[^a-z]/g, "")))?.domain || sites?.[0]?.domain || "";
  const link = `https://${domain}${path.startsWith("/") ? path : "/" + path}?utm_source=${encodeURIComponent(pub.network || "social")}&utm_medium=social&utm_campaign=${pub.campaign}`;
  return (
    <div className="rounded-2xl border border-border bg-raised p-4">
      <div className="flex items-center justify-between text-sm"><span>Lien de suivi</span><span className="num text-muted">{fmt(pub.visits ?? 0)} visite{(pub.visits ?? 0) > 1 ? "s" : ""} amenée{(pub.visits ?? 0) > 1 ? "s" : ""}</span></div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr]">
        <select aria-label="Site" value={domain} onChange={(e) => setSite(e.target.value)} className={inputCls}>{sites?.map((s) => <option key={s.domain} value={s.domain}>{s.domain}</option>)}</select>
        <input aria-label="Page" value={path} onChange={(e) => setPath(e.target.value)} className={inputCls} placeholder="/page" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1.5 font-mono text-xs">{link}</code>
        <Button type="button" variant="secondary" onClick={async () => { const ok = await copyText(link); setCopied(ok); setCopyErr(!ok); setTimeout(() => { setCopied(false); setCopyErr(false); }, 1500); }}>{copied ? "Copié" : "Copier"}</Button>
      </div>
      {copyErr && <p role="status" className="mt-1 text-xs text-negative">Copie impossible : sélectionnez le texte.</p>}
      <p className="mt-2 text-xs text-muted">Mettez ce lien dans la bio ou la description : chaque visite arrivée par lui est comptée ici (code « {pub.campaign} »).</p>
    </div>
  );
}

function PubSheet({ pub, projects, onClose, onSaved }: { pub: Partial<Pub>; projects: ProjectRef[]; onClose: () => void; onSaved: () => void }) {
  const { ask, dialog } = useAsk();
  const [error, setError] = useState("");
  const [id, setId] = useState(pub.id ?? null);
  const [project, setProject] = useState(pub.project ?? "");
  const [network, setNetwork] = useState(pub.network ?? "");
  const [text, setText] = useState(pub.text ?? "");
  const [account, setAccount] = useState(pub.account_id ?? "");
  const [visible, setVisible] = useState(pub.visible ?? "");
  const [state, setState] = useState(pub.state ?? "draft");
  const [evidence, setEvidence] = useState(pub.evidence_url ?? "");
  const [at, setAt] = useState("");
  const [attempts, setAttempts] = useState<{ ts: number; state: string; detail: string | null; evidence_url: string | null }[]>([]);
  const [media, setMedia] = useState<{ id: string; name: string; mime: string; size: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const { data: accounts } = useData<Account[]>("/api/pub-accounts");
  // Le compte peut porter l'identifiant du projet (connexion OAuth) ou sa clé CRM : les deux comptent.
  const sameProject = (a: string) => { const p = projects.find((x) => keysOf(x).includes(project)); return a === project || (!!p && keysOf(p).includes(a)); };
  const mine = (accounts ?? []).filter((a) => !project || sameProject(a.project));
  const limits = NET_LIMIT;

  useEffect(() => {
    if (!id) return;
    void api<any[]>(`/api/publications/${id}/attempts`).then(setAttempts).catch(() => {});
    void api<any[]>(`/api/publications/${id}/media`).then(setMedia).catch(() => {});
  }, [id, state]);

  async function upload(file: File) {
    setError("");
    try {
      const r = await fetch(`/api/publications/${id}/media?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Téléversement refusé");
      setMedia(await api(`/api/publications/${id}/media`));
    } catch (err) { setError((err as Error).message); }
  }
  async function dropMedia(mediaId: string) {
    await api(`/api/publications/${id}/media/${mediaId}`, { method: "DELETE" });
    setMedia(await api(`/api/publications/${id}/media`));
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    try {
      const body = Object.fromEntries(new FormData(e.currentTarget));
      const saved = await api<Pub>(id ? `/api/publications/${id}` : "/api/publications", { method: id ? "PATCH" : "POST", json: { ...body, text, account_id: account || null, visible: visible || null } });
      setId(saved.id); setState(saved.state ?? "draft"); onSaved();
    } catch (err) { setError((err as Error).message); }
  }
  async function queue(now: boolean) {
    if (!id) { setError("Enregistrez d'abord le brouillon."); return; }
    setBusy(true); setError("");
    try {
      const p = await api<Pub>(`/api/publications/${id}/queue`, { method: "POST", json: { now, at: now ? undefined : at ? new Date(at).toISOString() : undefined, text, account_id: account || undefined, visible: visible || undefined } });
      setState(p.state ?? ""); setEvidence(p.evidence_url ?? ""); onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function cancel() {
    setError("");
    try { const p = await api<Pub>(`/api/publications/${id}/cancel`, { method: "POST" }); setState(p.state ?? "cancelled"); onSaved(); }
    catch (err) { setError((err as Error).message); }
  }
  async function retry() {
    setBusy(true); setError("");
    try { const p = await api<Pub>(`/api/publications/${id}/retry`, { method: "POST" }); setState(p.state ?? ""); setEvidence(p.evidence_url ?? ""); onSaved(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if ((await ask({ title: "Supprimer cette publication ?", message: "Le suivi de ses liens cesse.", confirmLabel: "Supprimer" })) === null) return;
    await api(`/api/publications/${id}`, { method: "DELETE" }); onSaved(); onClose();
  }
  async function resolve(outcome: "published" | "draft") {
    setBusy(true); setError("");
    try {
      let url: string | undefined;
      if (outcome === "published") { const u = await ask({ title: "Marquer comme publiée ?", message: "Vous avez vérifié sur le réseau que la publication existe. Collez son adresse comme preuve.", confirmLabel: "Marquer publiée", inputLabel: "Adresse de la publication" }); if (u === null) return; url = u || undefined; }
      const p = await api<Pub>(`/api/publications/${id}/resolve`, { method: "POST", json: { outcome, url } });
      setState(p.state ?? ""); setEvidence(p.evidence_url ?? ""); onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const canQueue = !!id && ["draft", "failed", "missed", "needs_action", "scheduled", "cancelled"].includes(state);
  const limit = limits[network];
  const st = PUB_STATE[state] ?? [state, "text-muted"];

  return (
    <Sheet title={id ? "Publication" : "Nouvelle publication"} onClose={onClose}>
      {dialog}
      <form onSubmit={save} className="space-y-4 rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-3 text-sm">
          <span className={st[1]}>● {st[0]}</span>
          {evidence && <a href={evidence} target="_blank" rel="noreferrer" className="text-ink underline">Voir la preuve</a>}
        </div>
        {state === "to_verify" && (
          <div role="status" className="rounded-xl border border-negative/40 bg-negative-bg p-3 text-sm">
            <p>Le résultat est incertain : l'envoi a peut-être eu lieu. Rien ne sera renvoyé automatiquement. Regardez sur le réseau, puis choisissez :</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => resolve("published")}>Marquer publiée</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => resolve("draft")}>Remettre en brouillon</Button>
            </div>
          </div>
        )}
        {state === "needs_action" && mine.find((a) => a.id === account)?.mode === "agent" && (
          <div role="status" className="rounded-xl border border-border bg-raised p-3 text-sm">
            <p>À publier par votre agent IA (outil MCP <code>pubs_to_publish</code>, par exemple Claude dans Chrome sur votre ordinateur) ou à la main. Une fois le post en ligne, son adresse fait la preuve.</p>
            <Button type="button" variant="secondary" className="mt-2" disabled={busy} onClick={async () => {
              const u = await ask({ title: "Adresse du post publié", message: "Collez l'adresse https du post sur le réseau.", inputLabel: "Adresse du post", confirmLabel: "Marquer publiée" });
              if (!u) return;
              try { const p = await api<Pub>(`/api/publications/${id}/agent-published`, { method: "POST", json: { url: u } }); setState(p.state ?? ""); setEvidence(p.evidence_url ?? ""); onSaved(); } catch (err) { setError((err as Error).message); }
            }}>C'est publié</Button>
          </div>
        )}
        {state === "scheduled" && <p className="text-xs text-muted">Publication programmée : le contenu est figé. Annulez-la pour le modifier, puis reprogrammez.</p>}
        <Field label="Titre *"><input name="title" required defaultValue={pub.title} className={inputCls} autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date *"><input name="day" type="date" required defaultValue={pub.day} className={inputCls} /></Field>
          <Field label="Statut"><select name="status" defaultValue={pub.status} className={inputCls}>{PUB_STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Projet"><select name="project" aria-label="Projet" value={project} onChange={(e) => { setProject(e.target.value); setAccount(""); }} className={inputCls}>
            <option value="">— aucun —</option>
            {projects.map((p) => <option key={p.id} value={projectKey(p)}>{p.name}</option>)}
            {project && !projects.some((p) => keysOf(p).includes(project)) && <option value={project}>{project}</option>}
          </select></Field>
          <Field label="Réseau"><input name="network" list="reseaux" value={network} onChange={(e) => setNetwork(e.target.value)} className={inputCls} /></Field>
        </div>
        <datalist id="reseaux">{NETWORKS.map((n) => <option key={n} value={n} />)}</datalist>
        <Field label={`Texte${limit ? ` (${text.length} / ${limit})` : ""}`}>
          <textarea name="text" rows={5} value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} h-auto py-2`} placeholder="Ce que vous voulez publier…" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Compte de publication">
            <select aria-label="Compte de publication" value={account} onChange={(e) => setAccount(e.target.value)} className={inputCls}>
              <option value="">— choisir —</option>
              {mine.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.network})</option>)}
            </select>
          </Field>
          <Field label="Confidentialité (TikTok)"><select aria-label="Confidentialité" value={visible} onChange={(e) => setVisible(e.target.value)} className={inputCls}>
            <option value="">— choisir —</option><option value="public">Publique</option><option value="unlisted">Non répertoriée</option><option value="private">Privée</option>
          </select></Field>
        </div>
        <Field label="Lien de la publication"><input name="url" type="url" defaultValue={pub.url ?? ""} className={inputCls} /></Field>
        <Field label="Notes"><textarea name="notes" rows={3} defaultValue={pub.notes ?? ""} className={`${inputCls} h-auto py-2`} /></Field>
        {id && pub.campaign && <TrackingLink pub={{ ...pub, project }} />}
        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button>{id ? "Enregistrer le brouillon" : "Créer le brouillon"}</Button>
          {(!id || canQueue) && <Button type="button" variant="secondary" disabled={busy || !canQueue} onClick={() => queue(true)}>Publier maintenant</Button>}
          {(!id || canQueue) && <Button type="button" variant="secondary" disabled={busy || !canQueue || !at} onClick={() => queue(false)}>Programmer</Button>}
          {id && ["scheduled", "draft", "failed", "needs_action", "missed"].includes(state) && <button type="button" onClick={cancel} className="text-sm text-negative hover:underline">Annuler</button>}
          {id && ["failed", "needs_action", "missed"].includes(state) && <button type="button" onClick={retry} className="text-sm text-ink underline">Réessayer</button>}
          {id && <button type="button" onClick={remove} className="ml-auto text-sm text-negative hover:underline">Supprimer</button>}
        </div>
        {id && (
          <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-raised p-3">
            <Field label="Programmer pour"><input aria-label="Date et heure" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={inputCls} /></Field>
            <p className="text-xs text-muted">Tâche d'une minute. Retard de plus de 2 h : « Manqué », jamais publié sans votre décision.</p>
          </div>
        )}
        {id && (
          <div className="rounded-xl border border-border bg-raised p-3">
            <p className="text-sm">Médias <span className="text-xs text-muted">JPEG, PNG, WebP, GIF, MP4, MOV, WebM · 25 Mo maximum</span></p>
            <input type="file" aria-label="Ajouter un média" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
              onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void upload(f); e.currentTarget.value = ""; }} className="mt-2 block text-sm" />
            {media.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm">
                {media.map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <a href={`/api/media/${m.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink underline">{m.name}</a>
                    <span className="text-xs text-muted">{m.mime} · {(m.size / 1024).toFixed(0)} Ko</span>
                    <button type="button" onClick={() => dropMedia(m.id)} className="text-xs text-negative hover:underline">Retirer</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {id && <FollowupsBox id={id} state={state} pub={pub} />}
        {attempts.length > 0 && (
          <div>
            <p className="text-sm">Tentatives</p>
            <ul className="mt-1 space-y-1 text-xs text-muted">
              {attempts.map((a, i) => <li key={i}><span className="num">{new Date(a.ts).toLocaleString("fr-FR")}</span> · {ATTEMPT_LABEL[a.state] ?? "Autre"} {a.detail ? `· ${a.detail}` : ""}</li>)}
            </ul>
          </div>
        )}
      </form>
    </Sheet>
  );
}

type Followup = { idx: number; kind: string; text: string; state: string; url: string | null; detail: string | null };
const FSTATE: Record<string, [string, string]> = { pending: ["En attente", "text-muted"], running: ["En cours", "text-muted"], sent: ["Envoyée", "text-positive"], failed: ["Échec", "text-negative"], to_verify: ["À vérifier", "text-warn"] };

/** Premier commentaire et fil : modifiables tant que la publication n'est pas partie, puis suivis partie par partie. */
function FollowupsBox({ id, state, pub }: { id: string; state: string; pub: Partial<Pub> & { first_comment?: string | null; thread?: string | null } }) {
  const { data, reload } = useData<Followup[]>(`/api/publications/${id}/followups`);
  const [comment, setComment] = useState(pub.first_comment ?? "");
  const [parts, setParts] = useState<string[]>(() => { try { return pub.thread ? JSON.parse(pub.thread) : []; } catch { return []; } });
  const [msg, setMsg] = useState("");
  const editable = ["draft", "failed", "missed", "needs_action", "cancelled"].includes(state);
  const save = async () => {
    setMsg("");
    try { await api(`/api/publications/${id}/followups`, { method: "PUT", json: { first_comment: comment, thread: parts } }); setMsg("Suites enregistrées"); }
    catch (e) { setMsg((e as Error).message); }
  };
  const act = async (idx: number, body: Record<string, string> = {}) => { await api(`/api/publications/${id}/followups/${idx}`, { method: "POST", json: body }).catch((e) => setMsg((e as Error).message)); reload(); };
  if (!editable && !data?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-raised p-3 text-sm">
      <p>Suites <span className="text-xs text-muted">premier commentaire et fil, envoyés après la publication</span></p>
      {editable ? (
        <div className="mt-2 space-y-2">
          {parts.map((t, i) => (
            <div key={i} className="flex gap-2"><textarea aria-label={`Partie ${i + 2} du fil`} rows={2} value={t} onChange={(e) => setParts(parts.map((x, j) => j === i ? e.target.value : x))} className={`${inputCls} h-auto py-2`} />
              <button type="button" onClick={() => setParts(parts.filter((_, j) => j !== i))} className="text-xs text-negative">Retirer</button></div>))}
          <button type="button" onClick={() => setParts([...parts, ""])} className="text-xs text-muted underline">+ Partie de fil (X)</button>
          <textarea aria-label="Premier commentaire" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Premier commentaire (facultatif)" className={`${inputCls} h-auto py-2`} />
          <Button type="button" variant="secondary" onClick={save}>Enregistrer les suites</Button>
        </div>
      ) : (
        <ul className="mt-2 space-y-1">{(data ?? []).map((f) => (
          <li key={f.idx} className="flex flex-wrap items-baseline gap-2">
            <span className={FSTATE[f.state]?.[1]}>● {FSTATE[f.state]?.[0] ?? f.state}</span>
            <span className="min-w-0 flex-1 truncate">{f.kind === "thread" ? `Partie ${f.idx + 1}` : "Premier commentaire"} · {f.text}</span>
            {f.url && <a href={f.url} target="_blank" rel="noreferrer" className="text-xs underline">voir</a>}
            {f.state === "failed" && <button type="button" onClick={() => act(f.idx)} className="text-xs underline">Réessayer</button>}
            {f.state === "to_verify" && <><button type="button" onClick={() => act(f.idx, { outcome: "sent" })} className="text-xs underline">Elle est en ligne</button><button type="button" onClick={() => act(f.idx, { outcome: "pending" })} className="text-xs underline">Renvoyer</button></>}
            {f.detail && <span className="w-full text-xs text-muted">{f.detail}</span>}
          </li>))}</ul>
      )}
      {msg && <p role="status" className="mt-2 text-xs">{msg}</p>}
    </div>
  );
}

type Account = { id: string; project: string; network: string; label: string; status: string; mode: string; web_url: string | null; publications: number; connection_id?: string | null; browser_fallback?: number; target?: string | null };
/** Réseaux dont chaque compte vise une cible à régler (même règle côté serveur). */
const TARGET: Record<string, { label: string; help: string }> = { reddit: { label: "Subreddit", help: "Nom du subreddit sans « r/ » (ex. entrepreneur). Lisez ses règles : beaucoup refusent les liens ou l'autopromotion." } };

/** Comptes de publication de la phase 1 (fournisseur de test) : aucun réseau réel n'est joint. */
type Network = { id: string; label: string; configured: boolean };

/** Comptes de réseaux : ceux du projet choisi (ou de tous), connexion d'un réseau directement pour ce projet. */
function AccountsCard({ project, projects }: { project?: ProjectRef; projects: ProjectRef[] }) {
  const { ask, dialog } = useAsk();
  const { data, reload } = useData<Account[]>(`/api/pub-accounts${project ? `?project=${encodeURIComponent(project.id)}` : ""}`);
  const { data: networks } = useData<Network[]>("/api/pub-oauth/networks");
  const [chosen, setChosen] = useState("");
  const connectFor = project?.id ?? chosen;
  async function connect(n: Network) {
    setError("");
    try { const r = await api<{ url: string }>(`/api/pub-oauth/${n.id}/start`, { method: "POST", json: { project: connectFor } }); window.location.href = r.url; }
    catch (err) { setError((err as Error).message); }
  }
  const nameOf = (key: string) => projects.find((p) => p.id === key || p.crm_key === key)?.name ?? key;
  const { data: recipes } = useData<{ network: string; validated: string | null }[]>("/api/browser/recipes");
  const { data: mods } = useData<{ id: string; enabled: boolean }[]>("/api/modules");
  const queueOff = mods?.some((m) => m.id === "publications" && !m.enabled);
  const [error, setError] = useState("");
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    try { await api("/api/pub-accounts", { method: "POST", json: Object.fromEntries(new FormData(e.currentTarget)) }); reload(); (e.currentTarget as HTMLFormElement).reset(); }
    catch (err) { setError((err as Error).message); }
  }
  async function toggleFallback(a: Account) {
    setError("");
    if (!a.browser_fallback) {
      const ok = await ask({ title: `Repli navigateur pour « ${a.label} » ?`, confirmLabel: "Activer",
        message: "Si l'API ne peut pas publier (jeton refusé, quota), Searchtide publiera par le navigateur intégré avec votre session. La plupart des réseaux restreignent l'automatisation hors API : votre compte peut être limité. Enregistrez ensuite la session de ce compte dans « Connexions navigateur »." });
      if (ok === null) return;
    }
    try { await api(`/api/pub-accounts/${a.id}`, { method: "PATCH", json: { browser_fallback: !a.browser_fallback } }); reload(); }
    catch (err) { setError((err as Error).message); }
  }
  async function setTarget(a: Account) {
    const t = TARGET[a.network];
    const v = await ask({ title: `${t.label} de « ${a.label} »`, message: t.help, inputLabel: t.label, confirmLabel: "Enregistrer" });
    if (!v) return;
    setError("");
    try { await api(`/api/pub-accounts/${a.id}`, { method: "PATCH", json: { target: v } }); reload(); }
    catch (err) { setError((err as Error).message); }
  }
  async function remove(a: Account) {
    if ((await ask({ title: `Retirer le compte « ${a.label} » ?`, message: "Ses publications programmées seront annulées.", confirmLabel: "Retirer" })) === null) return;
    await api(`/api/pub-accounts/${a.id}`, { method: "DELETE" }); reload();
  }
  return (
    <Card title={project ? `Comptes de réseaux · ${project.name}` : "Comptes de réseaux"}>
      {dialog}
      <div className="mb-5">
        <p className="mb-2 text-sm text-muted">{project ? "Connectez les comptes de ce projet : chaque publication du projet part sur ses comptes." : "Choisissez le projet, puis connectez ses comptes."}</p>
        <div className="flex flex-wrap items-center gap-2">
          {!project && <select aria-label="Projet à connecter" value={chosen} onChange={(e) => setChosen(e.target.value)} className={`${inputCls} w-auto`}>
            <option value="">Projet…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          {(networks ?? []).filter((n) => n.configured).map((n) => <Button key={n.id} variant="secondary" disabled={!connectFor} onClick={() => connect(n)}>Connecter {n.label}</Button>)}
          {networks && !networks.some((n) => n.configured) && <span className="text-sm text-muted">Aucun réseau configuré : Plus → Connexions donne la marche à suivre pour chacun.</span>}
        </div>
      </div>
      <p className="mb-2 text-xs text-muted">Sans application développeur : ajoutez un compte « Navigateur » ou « Ordinateur de l'agent » (publication par votre session ou votre agent), ou un compte de test.</p>
      <form onSubmit={add} className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_1.4fr_auto]">
        {project ? <input type="hidden" name="project" value={projectKey(project)} />
          : <select name="project" required aria-label="Projet du compte" className={inputCls}><option value="">Projet…</option>{projects.map((p) => <option key={p.id} value={projectKey(p)}>{p.name}</option>)}</select>}
        <select name="network" required aria-label="Réseau du compte" className={inputCls}>{NETWORKS.filter((n) => NET_NAME[n]).map((n) => <option key={n} value={n}>{NET_NAME[n]}</option>)}</select>
        <input name="label" required aria-label="Nom du compte" placeholder="Nom du compte" className={inputCls} />
        <select name="mode" aria-label="Mode du compte" className={inputCls}><option value="api">Compte de test</option><option value="web">Navigateur</option><option value="agent">Publication par l'ordinateur de l'agent</option></select>
        <input name="web_url" aria-label="Adresse de connexion" placeholder="https://… (navigateur)" className={inputCls} />
        <Button>Ajouter</Button>
      </form>
      {queueOff && <p role="status" className="mb-2 text-sm text-negative">Le module Publications est désactivé : la file ne tourne pas, rien ne partira tant qu'il ne sera pas réactivé.</p>}
      {error && <p role="alert" className="mb-2 text-sm text-negative">{error}</p>}
      <Table rows={data ?? []} empty={project ? "Aucun compte pour ce projet : connectez-en un ci-dessus." : "Aucun compte de publication."} cols={[
        { label: "Compte", render: (a) => a.label },
        { label: "Réseau", render: (a) => NET_NAME[a.network] ?? a.network },
        ...(project ? [] : [{ label: "Projet", render: (a: Account) => nameOf(a.project) }]),
        { label: "Cible", render: (a) => TARGET[a.network] ? (
          <button type="button" onClick={() => setTarget(a)} className={a.target ? "text-ink underline" : "font-semibold text-accent hover:underline"}>{a.target ? `r/${a.target}` : `Choisir le ${TARGET[a.network].label.toLowerCase()}`}</button>) : <span className="text-muted">—</span> },
        { label: "Mode de publication", render: (a) => a.mode === "web" ? "Navigateur" : a.mode === "agent" ? "Ordinateur de l'agent" : a.connection_id ? "API" : "Compte de test" },
        { label: "Repli navigateur", render: (a) => a.mode === "web" || a.mode === "agent" || !recipes?.some((r) => r.network === a.network) ? <span className="text-muted">—</span> : (
          <label className="flex items-center gap-2"><input type="checkbox" checked={!!a.browser_fallback} onChange={() => toggleFallback(a)} className="size-4 accent-[var(--color-accent)]" aria-label="Repli navigateur" />
            <span className="text-xs text-muted">{a.browser_fallback ? "activé" : "désactivé"}</span></label>) },
        { label: "État", render: (a) => <Pill tone={a.status === "connected" ? "positive" : "negative"}>{a.status === "connected" ? "Connecté" : "À reconnecter"}</Pill> },
        { label: "", num: true, render: (a) => <button onClick={() => remove(a)} className="text-negative hover:underline">Retirer</button> },
      ]} />
    </Card>
  );
}
