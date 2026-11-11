// Module Publications : bloc de la semaine et calendrier éditorial.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../../App";
import { Button, Card, EmptyBox, Pill, Segmented, Table, fmt, inputCls, copyText, useAsk } from "../../ui";
import { PUB_STATE } from "../shared";
import { type Contact, type Pub, type Summary, type Go, STAGES, type Stage, stageName, KINDS, PUB_STATUS, NETWORKS, filterCls, eur, today, dateFr, Sheet, Field } from "../shared";

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
              <StatusPill s={p.status} />
            </li>
          ))}
        </ul>
      ) : <EmptyBox>Rien de prévu cette semaine. <button onClick={() => go({ view: "pubs", id: undefined, site: undefined })} className="text-ink underline">Planifier une publication</button></EmptyBox>}
    </Card>
  );
}

function StatusPill({ s }: { s: Pub["status"] }) {
  return <Pill tone={s === "published" ? "positive" : "neutral"}>{PUB_STATUS.find(([k]) => k === s)?.[1]}</Pill>;
}

// ── Calendrier des publications ──
export function PubsView({ q, go }: { q: Record<string, string>; go: Go }) {
  const month = /^\d{4}-\d{2}$/.test(q.month ?? "") ? q.month : today().slice(0, 7);
  const first = new Date(month + "-01T00:00:00Z");
  const start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 86400000);
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
  const { data, error, reload } = useData<Pub[]>(`/api/publications?from=${days[0]}&to=${days[41]}${q.project ? `&project=${q.project}` : ""}`);
  const [edit, setEdit] = useState<Partial<Pub> | null>(null);
  const shift = (n: number) => { const d = new Date(first); d.setUTCMonth(d.getUTCMonth() + n); go({ month: d.toISOString().slice(0, 7) }); };
  const byDay = useMemo(() => (data ?? []).reduce<Record<string, Pub[]>>((m, p) => ((m[p.day] ??= []).push(p), m), {}), [data]);
  const counts = { published: data?.filter((p) => p.day.startsWith(month) && p.status === "published").length ?? 0, planned: data?.filter((p) => p.day.startsWith(month) && p.status !== "published").length ?? 0 };
  return (
    <>
      <Header title="Publications" sub={`${dateFr(month + "-01", { month: "long", year: "numeric" })} · ${counts.published} publiées, ${counts.planned} prévues`}>
        <Button variant="secondary" onClick={() => shift(-1)} aria-label="Mois précédent">←</Button>
        <Button variant="secondary" onClick={() => go({ month: undefined })}>Aujourd'hui</Button>
        <Button variant="secondary" onClick={() => shift(1)} aria-label="Mois suivant">→</Button>
        <Button onClick={() => setEdit({ day: today(), status: "scheduled" })}>Nouvelle publication</Button>
      </Header>
      {error ? <ErrorLine error={error} retry={reload} /> : !data ? <KpiSkeleton /> : (
        <>
          <div className="hidden overflow-hidden rounded-2xl border border-border bg-surface md:block">
            <div className="grid grid-cols-7 border-b border-border text-xs text-muted">
              {["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."].map((d) => <div key={d} className="px-3 py-2">{d}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d) => (
                <div key={d} onDoubleClick={() => setEdit({ day: d, status: "scheduled" })}
                  className={`min-h-28 border-r border-b border-rule p-2 [&:nth-child(7n)]:border-r-0 ${d.startsWith(month) ? "" : "opacity-40"}`}>
                  <div className={`num mb-1 text-xs ${d === today() ? "inline-grid size-6 place-items-center rounded-full bg-accent text-on-accent" : "text-muted"}`}>{Number(d.slice(8))}</div>
                  <div className="space-y-1">
                    {byDay[d]?.map((p) => (
                      <button key={p.id} onClick={() => setEdit(p)} title={p.title}
                        className={`block w-full truncate rounded-lg px-2 py-1 text-left text-xs ${p.status === "published" ? "bg-positive-bg text-positive" : p.status === "idea" ? "border border-dashed border-control text-muted" : "bg-raised"}`}>
                        {p.network && <span className="text-muted">{p.network} · </span>}{p.title}
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
                    <span className="num w-14 shrink-0 text-muted">{dateFr(p.day)}</span><span className="min-w-0 flex-1 truncate">{p.title}</span><StatusPill s={p.status} />
                  </button></li>
                ))}
              </ul>
            ) : <EmptyBox>Rien de prévu ce mois-ci. <button type="button" onClick={() => setEdit({ day: today(), status: "scheduled" })} className="text-ink underline">Planifier une publication</button></EmptyBox>}
          </Card>
          <p className="mt-3 hidden text-xs text-muted md:block">Double-cliquez sur un jour pour y ajouter une publication.</p>
          <div className="mt-4"><AccountsCard /></div>
        </>
      )}
      {edit && <PubSheet pub={edit} onClose={() => setEdit(null)} onSaved={reload} />}
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

function PubSheet({ pub, onClose, onSaved }: { pub: Partial<Pub>; onClose: () => void; onSaved: () => void }) {
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
  const mine = (accounts ?? []).filter((a) => !project || a.project === project);
  const limits: Record<string, number> = { x: 280, instagram: 2200, facebook: 63206, tiktok: 2200, youtube: 5000, linkedin: 3000 };

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
        <Field label="Titre *"><input name="title" required defaultValue={pub.title} className={inputCls} autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date *"><input name="day" type="date" required defaultValue={pub.day} className={inputCls} /></Field>
          <Field label="Statut"><select name="status" defaultValue={pub.status} className={inputCls}>{PUB_STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Projet"><input name="project" value={project} onChange={(e) => setProject(e.target.value)} className={inputCls} placeholder="monprojet, monapp…" /></Field>
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
          <Button type="button" variant="secondary" disabled={busy || !id} onClick={() => queue(true)}>Publier maintenant</Button>
          <Button type="button" variant="secondary" disabled={busy || !id || !at} onClick={() => queue(false)}>Programmer</Button>
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
        {attempts.length > 0 && (
          <div>
            <p className="text-sm">Tentatives</p>
            <ul className="mt-1 space-y-1 text-xs text-muted">
              {attempts.map((a, i) => <li key={i}><span className="num">{new Date(a.ts).toLocaleString("fr-FR")}</span> · {a.state} {a.detail ? `· ${a.detail}` : ""}</li>)}
            </ul>
          </div>
        )}
      </form>
    </Sheet>
  );
}

type Account = { id: string; project: string; network: string; label: string; status: string; mode: string; web_url: string | null; publications: number };

/** Comptes de publication de la phase 1 (fournisseur factice) : aucun réseau réel n'est joint. */
function AccountsCard() {
  const { ask, dialog } = useAsk();
  const { data, reload } = useData<Account[]>("/api/pub-accounts");
  const [error, setError] = useState("");
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    try { await api("/api/pub-accounts", { method: "POST", json: Object.fromEntries(new FormData(e.currentTarget)) }); reload(); (e.currentTarget as HTMLFormElement).reset(); }
    catch (err) { setError((err as Error).message); }
  }
  async function remove(a: Account) {
    if ((await ask({ title: `Retirer le compte « ${a.label} » ?`, message: "Ses publications programmées seront annulées.", confirmLabel: "Retirer" })) === null) return;
    await api(`/api/pub-accounts/${a.id}`, { method: "DELETE" }); reload();
  }
  return (
    <Card title="Comptes de publication" action={<span className="text-xs text-muted">Fournisseur factice — aucun réseau joint</span>}>
      {dialog}
      <form onSubmit={add} className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_1.4fr_auto]">
        <input name="project" required aria-label="Projet du compte" placeholder="Projet (clé CRM)" className={inputCls} />
        <select name="network" required aria-label="Réseau du compte" className={inputCls}>{NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <input name="label" required aria-label="Nom du compte" placeholder="Nom du compte" className={inputCls} />
        <select name="mode" aria-label="Mode du compte" className={inputCls}><option value="api">API factice</option><option value="web">Navigateur</option></select>
        <input name="web_url" aria-label="Adresse de connexion" placeholder="https://… (navigateur)" className={inputCls} />
        <Button>Ajouter</Button>
      </form>
      {error && <p role="alert" className="mb-2 text-sm text-negative">{error}</p>}
      <Table rows={data ?? []} empty="Aucun compte de publication." cols={[
        { label: "Compte", render: (a) => a.label },
        { label: "Réseau", render: (a) => a.network },
        { label: "Projet", render: (a) => a.project },
        { label: "Transport", render: (a) => a.mode === "web" ? "Navigateur" : "API factice" },
        { label: "État", render: (a) => <Pill tone={a.status === "connected" ? "positive" : "negative"}>{a.status === "connected" ? "Connecté" : "À reconnecter"}</Pill> },
        { label: "", num: true, render: (a) => <button onClick={() => remove(a)} className="text-negative hover:underline">Retirer</button> },
      ]} />
    </Card>
  );
}
