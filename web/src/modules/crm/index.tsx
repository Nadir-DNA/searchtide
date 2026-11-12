// Module Contacts : pipeline, liste, relances, fiche, e-mails de prospection, import CSV.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../../App";
import { Button, Card, EmptyBox, Pill, Segmented, Table, fmt, inputCls, useAsk } from "../../ui";
import { type Contact, type Pub, type Summary, type Go, STAGES, type Stage, stageName, KINDS, PUB_STATUS, NETWORKS, filterCls, eur, today, dateFr, Sheet, Field } from "../shared";

// ── Résumé en tête de la vue d'ensemble ──
export function PipelineCard({ go, title = "Pipeline commercial" }: { go: Go; title?: string }) {
  const { data: s } = useData<Summary>("/api/business");
  if (!s) return <Card title={title}><KpiSkeleton /></Card>;
  const open = STAGES.filter(([k]) => k !== "lost");
  const max = Math.max(...open.map(([k]) => s.stages[k] ?? 0), 1);
  return (
    <Card title={title} action={<Button variant="secondary" onClick={() => go({ view: "crm", id: undefined, site: undefined })}>Contacts</Button>}>
      <ul className="space-y-2">
        {open.map(([k, label]) => (
          <li key={k}>
            <button onClick={() => go({ view: "crm", id: undefined, site: undefined })} className="relative flex h-9 w-full items-center gap-3 px-3 text-left text-sm">
              <span className="absolute inset-y-0 left-0 rounded-md bg-raised" style={{ width: `${Math.max(((s.stages[k] ?? 0) / max) * 100, 2)}%` }} aria-hidden />
              <span className="relative flex-1">{label}</span>
              <span className="num relative">{fmt(s.stages[k] ?? 0)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <span>En négociation <b className="num font-medium text-ink">{eur(s.pipelineValue)}</b></span>
        <span>Gagné ce mois <b className="num font-medium text-ink">{eur(s.wonMonth)}</b></span>
        <span>{fmt(s.touchesWeek)} échanges cette semaine</span>
      </p>
    </Card>
  );
}

// ── CRM ──
export function CrmView({ tab, go, q }: { tab: string; go: Go; q: Record<string, string> }) {
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const { data: s } = useData<Summary>(`/api/business?v=${version}`);
  const filters = { project: q.project, source: q.source, q: q.q };
  const setFilter = (k: string, v: string) => go({ [k]: v || undefined });
  const tabs = [["pipeline", "Pipeline"], ["list", "Liste"], ["todo", `À relancer${s?.todo ? ` · ${s.todo}` : ""}`], ["emails", "E-mails"]] as const;
  const current = (tab === "list" || tab === "todo" || tab === "emails" ? tab : "pipeline") as (typeof tabs)[number][0];
  return (
    <>
      <Header title="Contacts" sub={s ? `${fmt(Object.values(s.stages).reduce((a, b) => a + b, 0))} contacts · prospects et clients` : undefined}>
        <Button variant="secondary" onClick={() => setImporting(true)}>Importer</Button>
        <Button onClick={() => setOpen("new")}>Nouveau contact</Button>
      </Header>
      <div className="mb-5 -mt-1 flex flex-wrap items-center gap-3">
        <Segmented label="Vues" value={current} onChange={(v) => go({ tab: v === "pipeline" ? undefined : v })} options={tabs} />
        <input type="search" placeholder="Rechercher" defaultValue={q.q ?? ""} onKeyDown={(e) => e.key === "Enter" && setFilter("q", e.currentTarget.value)}
          className={`${filterCls} w-52`} aria-label="Rechercher un contact" />
        <select aria-label="Projet" className={`${filterCls} w-auto`} value={q.project ?? ""} onChange={(e) => setFilter("project", e.target.value)}>
          <option value="">Tous les projets</option>
          {s?.projects.filter((p) => p.project).map((p) => <option key={p.project} value={p.project}>{p.project} ({p.n})</option>)}
        </select>
        <select aria-label="Source" className={`${filterCls} w-auto`} value={q.source ?? ""} onChange={(e) => setFilter("source", e.target.value)}>
          <option value="">Toutes les sources</option>
          {s?.sources.filter((p) => p.source).map((p) => <option key={p.source} value={p.source}>{p.source} ({p.n})</option>)}
        </select>
      </div>
      {current === "emails" ? <EmailsView /> : current === "pipeline" ? <Pipeline key={version + JSON.stringify(filters)} filters={filters} onOpen={setOpen} onMoved={refresh} />
        : <ContactList key={version + current + JSON.stringify(filters)} filters={filters} todo={current === "todo"} onOpen={setOpen} />}
      {open && <ContactSheet id={open} projects={s?.projects.map((p) => p.project).filter(Boolean) ?? []} onClose={() => setOpen(null)} onSaved={refresh} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={refresh} />}
    </>
  );
}

const qs = (o: Record<string, string | number | boolean | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

function Pipeline({ filters, onOpen, onMoved }: { filters: Record<string, string | undefined>; onOpen: (id: string) => void; onMoved: () => void }) {
  const [cols, setCols] = useState<Record<string, { total: number; rows: Contact[] }> | null>(null);
  const [error, setError] = useState("");
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    Promise.all(STAGES.map(([st]) => api<{ total: number; rows: Contact[] }>(`/api/contacts?${qs({ ...filters, stage: st, limit: 40 })}`).then((r) => [st, r] as const)))
      .then((r) => setCols(Object.fromEntries(r))).catch((e) => setError(e.message));
  }, [filters]);
  async function drop(stage: string, id: string) {
    setOver(null);
    await api(`/api/contacts/${id}`, { method: "PATCH", json: { stage } }).catch((e) => setError(e.message));
    onMoved();
  }
  if (error) return <ErrorLine error={error} retry={onMoved} />;
  if (!cols) return <KpiSkeleton />;
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
      <div className="grid min-w-[1080px] grid-cols-6 gap-3">
        {STAGES.map(([st, label]) => (
          <section key={st} aria-label={label} onDragOver={(e) => { e.preventDefault(); setOver(st); }} onDragLeave={() => setOver(null)}
            onDrop={(e) => drop(st, e.dataTransfer.getData("text/plain"))}
            className={`flex min-h-[420px] flex-col rounded-2xl border bg-surface p-3 transition-colors ${over === st ? "border-accent" : "border-border"}`}>
            <div className="mb-3 flex items-center justify-between px-1 text-sm">
              <span>{label}</span><span className="num text-muted">{fmt(cols[st].total)}</span>
            </div>
            <div className="space-y-2">
              {cols[st].rows.map((c) => (
                <button key={c.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)} onClick={() => onOpen(c.id)}
                  className="block w-full rounded-xl border border-border bg-raised p-3 text-left text-sm hover:border-control">
                  <div className="truncate">{c.company || c.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted">{[c.company ? c.name : null, c.city, c.project].filter(Boolean).join(" · ") || "—"}</div>
                  {(c.value || c.next_at) && (
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="num">{c.value ? eur(c.value) : ""}</span>
                      {c.next_at && <span className={c.next_at <= today() ? "text-negative" : "text-muted"}>{dateFr(c.next_at)}</span>}
                    </div>
                  )}
                </button>
              ))}
              {cols[st].total > cols[st].rows.length && <p className="px-1 text-xs text-muted">+ {fmt(cols[st].total - cols[st].rows.length)} dans la liste</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ContactList({ filters, todo, onOpen }: { filters: Record<string, string | undefined>; todo: boolean; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const size = 50;
  const { data, error, reload } = useData<{ total: number; rows: Contact[] }>(`/api/contacts?${qs({ ...filters, todo: todo ? 1 : undefined, limit: size, offset: page * size })}`);
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!data) return <KpiSkeleton />;
  return (
    <Card>
      <Table rows={data.rows} onRow={(c) => onOpen(c.id)} empty={todo ? "Aucune relance prévue aujourd'hui. Fixez une date de relance dans la fiche d'un contact." : "Aucun contact. Ajoutez-en un ou importez une liste."} cols={[
        { label: "Contact", className: "w-2/3 md:w-1/3", render: (c) => <span className="flex min-w-0 flex-col"><span className="truncate">{c.company || c.name}</span><span className="truncate text-xs text-muted">{c.company ? c.name : c.sector}</span></span> },
        { label: "Étape", render: (c) => <Pill>{stageName[c.stage]}</Pill> },
        { label: "Ville", className: "hidden md:table-cell", render: (c) => c.city ?? <span className="text-muted">—</span> },
        { label: "Projet", className: "hidden md:table-cell", render: (c) => c.project ?? <span className="text-muted">—</span> },
        { label: todo ? "Relance" : "Prochaine action", className: "hidden lg:table-cell", render: (c) => c.next_at ? <span className={c.next_at <= today() ? "text-negative" : ""}>{dateFr(c.next_at)} {c.next_action && <span className="text-muted">· {c.next_action}</span>}</span> : <span className="text-muted">—</span> },
        { label: "Valeur", num: true, className: "hidden sm:table-cell", render: (c) => eur(c.value) },
      ]} />
      {data.total > size && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted">
          <span>{fmt(page * size + 1)}–{fmt(Math.min((page + 1) * size, data.total))} sur {fmt(data.total)}</span>
          <span className="flex gap-2">
            <Button variant="secondary" disabled={!page} onClick={() => setPage(page - 1)}>Précédent</Button>
            <Button variant="secondary" disabled={(page + 1) * size >= data.total} onClick={() => setPage(page + 1)}>Suivant</Button>
          </span>
        </div>
      )}
    </Card>
  );
}

function ContactSheet({ id, projects, onClose, onSaved }: { id: string; projects: string[]; onClose: () => void; onSaved: () => void }) {
  const { ask, dialog } = useAsk();
  const isNew = id === "new";
  const [c, setC] = useState<Contact | null>(isNew ? null : null);
  const [error, setError] = useState("");
  const [log, setLog] = useState({ kind: "note", text: "" });
  useEffect(() => { if (!isNew) api<Contact>(`/api/contacts/${id}`).then(setC).catch((e) => setError(e.message)); }, [id, isNew]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body = { ...f, value: f.value ? Number(f.value.replace(",", ".")) : null, tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [], opt_out: f.opt_out === "on" };
    try {
      const saved = await api<Contact>(isNew ? "/api/contacts" : `/api/contacts/${id}`, { method: isNew ? "POST" : "PATCH", json: body });
      setError(""); onSaved();
      if (isNew) onClose(); else setC(saved);
    } catch (err) { setError((err as Error).message); }
  }
  async function addLog(kind = log.kind, text = log.text) {
    if (!text.trim()) return;
    setC(await api<Contact>(`/api/contacts/${id}/activities`, { method: "POST", json: { kind, text } }));
    setLog({ kind: "note", text: "" }); onSaved();
  }
  async function remove() {
    if ((await ask({ title: "Supprimer ce contact et son historique ?", message: "Cette action est définitive.", confirmLabel: "Supprimer le contact" })) === null) return;
    await api(`/api/contacts/${id}`, { method: "DELETE" }); onSaved(); onClose();
  }
  if (!isNew && !c) return <Sheet title="Contact" onClose={onClose}>{error ? <ErrorLine error={error} retry={onClose} /> : <KpiSkeleton />}</Sheet>;
  const v = c ?? ({ stage: "new", tags: [], opt_out: false } as unknown as Contact);
  const tel = v.phone?.replace(/[^\d+]/g, "");
  return (
    <Sheet title={isNew ? "Nouveau contact" : v.company || v.name} onClose={onClose} wide>
      {dialog}
      {!isNew && (
        <div className="flex flex-wrap gap-2">
          {tel && <a href={`tel:${tel}`} onClick={() => !v.opt_out && addLog("call", "Appel passé")} className="inline-flex h-9 items-center rounded-full border border-control bg-raised px-4 text-sm hover:bg-active">Appeler</a>}
          {tel && !v.opt_out && <a href={`sms:${tel}`} className="inline-flex h-9 items-center rounded-full border border-control bg-raised px-4 text-sm hover:bg-active">SMS</a>}
          {v.email && !v.opt_out && <a href={`mailto:${v.email}`} className="inline-flex h-9 items-center rounded-full border border-control bg-raised px-4 text-sm hover:bg-active">E-mail</a>}
          {v.site_url && <a href={v.site_url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-full border border-control bg-raised px-4 text-sm hover:bg-active">Site ↗</a>}
          {v.opt_out && <Pill tone="negative">Ne plus contacter</Pill>}
        </div>
      )}
      <form onSubmit={save} className="rounded-2xl border border-border bg-surface p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom *"><input name="name" required defaultValue={v.name} className={inputCls} /></Field>
          <Field label="Entreprise"><input name="company" defaultValue={v.company ?? ""} className={inputCls} /></Field>
          <Field label="Téléphone"><input name="phone" type="tel" defaultValue={v.phone ?? ""} className={inputCls} /></Field>
          <Field label="E-mail"><input name="email" type="email" defaultValue={v.email ?? ""} className={inputCls} /></Field>
          <Field label="Ville"><input name="city" defaultValue={v.city ?? ""} className={inputCls} /></Field>
          <Field label="Secteur"><input name="sector" defaultValue={v.sector ?? ""} className={inputCls} /></Field>
          <Field label="Projet"><input name="project" list="projets" defaultValue={v.project ?? ""} className={inputCls} placeholder="monprojet, autreprojet…" /></Field>
          <Field label="Source"><input name="source" defaultValue={v.source ?? ""} className={inputCls} placeholder="site, recommandation…" /></Field>
          <Field label="Étape">
            <select name="stage" defaultValue={v.stage} className={inputCls}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
          <Field label="Valeur (€)"><input name="value" inputMode="decimal" defaultValue={v.value ?? ""} className={inputCls} /></Field>
          <Field label="Prochaine relance"><input name="next_at" type="date" defaultValue={v.next_at ?? ""} className={inputCls} /></Field>
          <Field label="Action prévue"><input name="next_action" defaultValue={v.next_action ?? ""} className={inputCls} placeholder="Rappeler, envoyer le devis…" /></Field>
          <Field label="Adresse" className="sm:col-span-2"><input name="address" defaultValue={v.address ?? ""} className={inputCls} /></Field>
          <Field label="Site web"><input name="site_url" defaultValue={v.site_url ?? ""} className={inputCls} /></Field>
          <Field label="Étiquettes (séparées par des virgules)"><input name="tags" defaultValue={v.tags.join(", ")} className={inputCls} /></Field>
        </div>
        <datalist id="projets">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" name="opt_out" defaultChecked={v.opt_out} className="size-4 accent-[var(--color-accent)]" />A demandé à ne plus être contacté</label>
        {error && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
        <div className="mt-5 flex items-center justify-between gap-3">
          <Button>{isNew ? "Créer le contact" : "Enregistrer"}</Button>
          {!isNew && <button type="button" onClick={remove} className="text-sm text-negative hover:underline">Supprimer</button>}
        </div>
      </form>
      {!isNew && <Duplicates id={id} onMerged={async () => { setC(await api<Contact>(`/api/contacts/${id}`)); onSaved(); }} />}
      {!isNew && !v.opt_out && v.email && <Composer contactId={id} onSent={async () => { setC(await api<Contact>(`/api/contacts/${id}`)); onSaved(); }} />}
      {!isNew && (
        <Card title="Historique">
          <div className="flex flex-wrap gap-2">
            <select aria-label="Type" value={log.kind} onChange={(e) => setLog({ ...log, kind: e.target.value })} className={`${inputCls} w-auto`}>
              {["note", "call", "email", "sms"].map((k) => <option key={k} value={k}>{KINDS[k]}</option>)}
            </select>
            <input aria-label="Texte" value={log.text} onChange={(e) => setLog({ ...log, text: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addLog()}
              placeholder="Ce qui a été dit ou fait" className={`${inputCls} min-w-0 flex-1`} />
            <Button variant="secondary" onClick={() => addLog()}>Ajouter</Button>
          </div>
          <ul className="mt-4 divide-y divide-rule">
            {c!.activities?.length ? c!.activities.map((a) => (
              <li key={a.id} className="flex gap-3 py-2.5 text-sm">
                <span className="num w-28 shrink-0 text-xs leading-5 text-muted">{new Date(a.ts).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
                <span className="w-14 shrink-0 text-xs leading-5 text-muted">{KINDS[a.kind] ?? a.kind}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{a.kind === "stage" ? a.text.replace(/\w+/g, (w) => stageName[w] ?? w) : a.text}</span>
              </li>
            )) : <li className="py-2.5 text-sm text-muted">Aucun échange enregistré.</li>}
          </ul>
        </Card>
      )}
    </Sheet>
  );
}

function Duplicates({ id, onMerged }: { id: string; onMerged: () => void }) {
  const { ask, dialog } = useAsk();
  const { data, reload } = useData<Contact[]>(`/api/contacts/${id}/duplicates`);
  if (!data?.length) return null;
  async function merge(other: Contact) {
    const ok = await ask({ title: `Fusionner « ${other.company || other.name} » dans cette fiche ?`, message: "Son historique est conservé, la fiche en double est supprimée.", confirmLabel: "Fusionner" });
    if (ok === null) return;
    await api(`/api/contacts/${id}/merge`, { method: "POST", json: { other_id: other.id } }); reload(); onMerged();
  }
  return (
    <div className="rounded-2xl border border-chart-3/50 bg-surface p-4 text-sm">
      {dialog}
      <p>Doublon{data.length > 1 ? "s" : ""} probable{data.length > 1 ? "s" : ""} (même téléphone, e-mail ou nom) :</p>
      <ul className="mt-2 space-y-1.5">{data.map((d) => (
        <li key={d.id} className="flex items-center gap-3"><span className="min-w-0 flex-1 truncate">{d.company || d.name} <span className="text-muted">· {[d.phone, d.email, stageName[d.stage]].filter(Boolean).join(" · ")}</span></span>
          <Button variant="secondary" onClick={() => merge(d)}>Fusionner ici</Button></li>
      ))}</ul>
    </div>
  );
}

type Outreach = {
  mail: boolean; sentToday: number; dailyLimit: number;
  templates: { id: string; name: string; subject: string; body: string }[];
  sequences: { id: string; name: string; steps: { delay_days: number; template_id: string }[]; active: boolean; counts: Record<string, number> }[];
};
const VARS = "{{prenom}} {{nom}} {{entreprise}} {{ville}} {{secteur}} {{site}}";

function Composer({ contactId, onSent }: { contactId: string; onSent: () => void }) {
  const { data: o } = useData<Outreach>("/api/outreach");
  const { data: enr, reload } = useData<{ sequence_id: string; name: string; status: string; step: number; next_at: string; reason: string | null }[]>(`/api/contacts/${contactId}/enrollments`);
  const [draft, setDraft] = useState({ subject: "", body: "" });
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [state, setState] = useState("");
  const pickTemplate = (tid: string) => { const t = o?.templates.find((x) => x.id === tid); if (t) { setDraft({ subject: t.subject, body: t.body }); setPreview(null); } };
  async function showPreview() { setPreview(await api(`/api/contacts/${contactId}/preview`, { method: "POST", json: draft })); }
  async function send() {
    setState("Envoi…");
    try { const r = await api<{ to: string }>(`/api/contacts/${contactId}/email`, { method: "POST", json: draft }); setState(`Envoyé à ${r.to}`); setDraft({ subject: "", body: "" }); setPreview(null); onSent(); }
    catch (e) { setState((e as Error).message); }
  }
  async function enrollIn(sid: string) {
    if (!sid) return;
    try { await api(`/api/contacts/${contactId}/enroll`, { method: "POST", json: { sequence_id: sid } }); reload(); onSent(); } catch (e) { setState((e as Error).message); }
  }
  if (!o) return null;
  return (
    <Card title="Écrire" action={<span className="text-xs text-muted">{o.sentToday} / {o.dailyLimit} e-mails aujourd'hui</span>}>
      {!o.mail && <p className="mb-3 text-sm text-muted">L'envoi n'est pas branché (SMTP_URL absent) : configurez l'e-mail dans Réglages pour envoyer depuis ici.</p>}
      <div className="space-y-3">
        {o.templates.length > 0 && (
          <select aria-label="Modèle" defaultValue="" onChange={(e) => pickTemplate(e.target.value)} className={inputCls}>
            <option value="">Partir d'un modèle…</option>{o.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <input aria-label="Objet" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Objet" className={inputCls} />
        <textarea aria-label="Message" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={6} placeholder={`Message. Variables : ${VARS}`} className={`${inputCls} h-auto py-2`} />
        {preview && <div className="rounded-xl border border-border bg-raised p-3 text-sm"><div className="font-medium">{preview.subject}</div><p className="mt-2 whitespace-pre-wrap">{preview.body}</p><p className="mt-2 text-xs text-muted">Un lien de désinscription est ajouté automatiquement en bas du message.</p></div>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={showPreview} disabled={!draft.body}>Aperçu</Button>
          <Button onClick={send} disabled={!o.mail || !draft.subject || !draft.body}>Envoyer</Button>
          <span className="text-sm text-muted">{state}</span>
        </div>
      </div>
      {o.sequences.length > 0 && (
        <div className="mt-5 border-t border-rule pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Séquence" defaultValue="" onChange={(e) => enrollIn(e.target.value)} className={`${inputCls} w-auto`}>
              <option value="">Ajouter à une séquence de relance…</option>{o.sequences.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.steps.length} e-mails)</option>)}
            </select>
          </div>
          {enr?.map((e) => <p key={e.sequence_id} className="mt-2 text-sm">{e.name} : {e.status === "active" ? `étape ${e.step + 1}, prochain envoi le ${new Date(e.next_at + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" })}` : e.status === "done" ? "terminée" : `arrêtée (${e.reason})`}</p>)}
        </div>
      )}
    </Card>
  );
}

function EmailsView() {
  const { ask, dialog } = useAsk();
  const { data: o, error, reload } = useData<Outreach>("/api/outreach");
  const [tpl, setTpl] = useState<Partial<Outreach["templates"][number]> | null>(null);
  const [seq, setSeq] = useState<Partial<Outreach["sequences"][number]> | null>(null);
  const [err, setErr] = useState("");
  async function saveTpl(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api(tpl?.id ? `/api/templates/${tpl.id}` : "/api/templates", { method: tpl?.id ? "PATCH" : "POST", json: Object.fromEntries(new FormData(e.currentTarget)) }); setTpl(null); setErr(""); reload(); }
    catch (x) { setErr((x as Error).message); }
  }
  async function saveSeq(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const delays = f.getAll("delay").map(Number), tids = f.getAll("template").map(String);
    const steps = tids.map((t, i) => ({ delay_days: delays[i] || 0, template_id: t })).filter((x) => x.template_id);
    try { await api(seq?.id ? `/api/sequences/${seq.id}` : "/api/sequences", { method: seq?.id ? "PATCH" : "POST", json: { name: f.get("name"), steps, active: f.get("active") === "on" } }); setSeq(null); setErr(""); reload(); }
    catch (x) { setErr((x as Error).message); }
  }
  const del = async (kind: string, id: string) => {
    if ((await ask({ title: kind === "templates" ? "Supprimer ce modèle ?" : "Supprimer cette séquence ?", confirmLabel: "Supprimer" })) === null) return;
    await api(`/api/${kind}/${id}`, { method: "DELETE" }); reload();
  };
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!o) return <KpiSkeleton />;
  return (
    <div className="space-y-4">
      {dialog}
      {!o.mail && <EmptyBox>L'envoi n'est pas encore branché : renseignez <code className="font-mono">SMTP_URL</code> et <code className="font-mono">REPORT_TO</code> dans <code className="font-mono">.env</code> (avec Gmail : mot de passe d'application). Vous pouvez préparer modèles et séquences dès maintenant.</EmptyBox>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Modèles" action={<Button onClick={() => setTpl({})}>Nouveau modèle</Button>}>
          {o.templates.length ? <ul className="divide-y divide-rule">{o.templates.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-3 text-sm"><span className="min-w-0 flex-1"><span className="block truncate">{t.name}</span><span className="block truncate text-xs text-muted">{t.subject}</span></span>
              <button onClick={() => setTpl(t)} className="text-muted hover:text-ink">Modifier</button><button onClick={() => del("templates", t.id)} className="text-negative hover:underline">Supprimer</button></li>
          ))}</ul> : <EmptyBox>Aucun modèle. Créez un premier message, puis une relance. <button type="button" onClick={() => setTpl({})} className="text-ink underline">Nouveau modèle</button></EmptyBox>}
        </Card>
        <Card title="Séquences de relance" action={<Button onClick={() => setSeq({ steps: [{ delay_days: 0, template_id: "" }, { delay_days: 3, template_id: "" }, { delay_days: 7, template_id: "" }], active: true })} disabled={!o.templates.length}>Nouvelle séquence</Button>}>
          {o.sequences.length ? <ul className="divide-y divide-rule">{o.sequences.map((x) => (
            <li key={x.id} className="flex items-center gap-3 py-3 text-sm"><span className="min-w-0 flex-1"><span className="block truncate">{x.name} {!x.active && <Pill>en pause</Pill>}</span>
              <span className="block truncate text-xs text-muted">{x.steps.map((st) => `J+${st.delay_days}`).join(" → ")} · {x.counts.active ?? 0} en cours, {x.counts.done ?? 0} terminées, {x.counts.stopped ?? 0} arrêtées</span></span>
              <button onClick={() => setSeq(x)} className="text-muted hover:text-ink">Modifier</button><button onClick={() => del("sequences", x.id)} className="text-negative hover:underline">Supprimer</button></li>
          ))}</ul> : <EmptyBox>Une séquence envoie vos modèles à intervalles (ex. J+0, J+3, J+7) et s'arrête dès que le contact avance dans le pipeline ou se désinscrit. <button type="button" onClick={() => setSeq({ steps: [{ delay_days: 0, template_id: "" }], active: true })} disabled={!o.templates.length} className="text-ink underline disabled:opacity-50">Nouvelle séquence</button></EmptyBox>}
        </Card>
      </div>
      {tpl && (
        <Card title={tpl.id ? "Modifier le modèle" : "Nouveau modèle"}>
          <form onSubmit={saveTpl} className="space-y-3">
            <Field label="Nom (pour vous)"><input name="name" required defaultValue={tpl.name} className={inputCls} placeholder="Premier contact garages" /></Field>
            <Field label="Objet"><input name="subject" required defaultValue={tpl.subject} className={inputCls} placeholder="{{entreprise}} : une question rapide" /></Field>
            <Field label={`Message · variables : ${VARS}`}><textarea name="body" required rows={8} defaultValue={tpl.body} className={`${inputCls} h-auto py-2`} /></Field>
            <p className="text-xs text-muted">Le lien de désinscription est ajouté automatiquement. Présentez-vous clairement et restez sur le métier du destinataire (prospection entre professionnels).</p>
            {err && <p role="alert" className="text-sm text-negative">{err}</p>}
            <div className="flex gap-2"><Button>Enregistrer</Button><Button type="button" variant="secondary" onClick={() => setTpl(null)}>Annuler</Button></div>
          </form>
        </Card>
      )}
      {seq && (
        <Card title={seq.id ? "Modifier la séquence" : "Nouvelle séquence"}>
          <form onSubmit={saveSeq} className="space-y-3">
            <Field label="Nom"><input name="name" required defaultValue={seq.name} className={inputCls} placeholder="Prospection sites vitrines" /></Field>
            {[0, 1, 2, 3, 4].map((k) => (
              <div key={k} className="grid grid-cols-[110px_1fr] gap-2">
                <input name="delay" type="number" min={0} max={90} aria-label={`Délai étape ${k + 1}`} defaultValue={seq.steps?.[k]?.delay_days ?? (k ? k * 4 : 0)} className={inputCls} />
                <select name="template" aria-label={`Modèle étape ${k + 1}`} defaultValue={seq.steps?.[k]?.template_id ?? ""} className={inputCls}>
                  <option value="">Étape {k + 1} : aucune</option>{o.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            ))}
            <p className="text-xs text-muted">Délai en jours après l'étape précédente (après l'ajout pour la première). Envois en semaine, de 9 h à 18 h, {o.dailyLimit} par jour au plus.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={seq.active ?? true} className="size-4 accent-[var(--color-accent)]" />Active</label>
            {err && <p role="alert" className="text-sm text-negative">{err}</p>}
            <div className="flex gap-2"><Button>Enregistrer</Button><Button type="button" variant="secondary" onClick={() => setSeq(null)}>Annuler</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

// Lecture d'un CSV simple (séparateur , ou ;, guillemets doubles)
function parseCsv(text: string) {
  const sep = (text.split("\n")[0].match(/;/g)?.length ?? 0) > (text.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim().toLowerCase(), r[i]?.trim() ?? ""])));
}

// Correspondance des colonnes courantes (fichiers Google Maps, exports CRM, ancien dash)
const pick = (r: Record<string, any>, ...keys: string[]) => keys.map((k) => r[k]).find((x) => x != null && String(x).trim() !== "") ?? null;
export function mapRow(r: Record<string, any>) {
  const labels = Array.isArray(r.labels) ? r.labels : typeof r.labels === "string" && r.labels ? r.labels.split(/[,;|]/).map((s: string) => s.trim()) : [];
  const company = pick(r, "company", "entreprise", "société", "societe", "title");
  return {
    name: pick(r, "name", "nom", "contact", "company", "entreprise") ?? "",
    company: company && company !== pick(r, "name", "nom") ? company : null,
    phone: pick(r, "phone", "téléphone", "telephone", "tel", "mobile"), email: pick(r, "email", "e-mail", "mail"),
    city: pick(r, "city", "ville", "_city"), address: pick(r, "address", "adresse"), sector: pick(r, "sector", "secteur", "profession", "_prof", "category"),
    site_url: pick(r, "site_url", "website", "site", "url"), source: pick(r, "source"),
    tags: labels.filter(Boolean).slice(0, 10),
  };
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [project, setProject] = useState("");
  const [result, setResult] = useState<{ added: number; skipped: number; invalid: number } | null>(null);
  const [error, setError] = useState("");
  async function read(file: File) {
    setError(""); setResult(null);
    const text = await file.text();
    try {
      const raw = /\.(nd)?json$/i.test(file.name)
        ? (text.trim().startsWith("[") ? JSON.parse(text) : text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)))
        : parseCsv(text);
      setRows(raw.map(mapRow));
    } catch { setError("Fichier illisible : CSV, JSON ou NDJSON attendu."); }
  }
  const sample = useMemo(() => rows?.slice(0, 5) ?? [], [rows]);
  async function send() {
    try { setResult(await api("/api/contacts/import", { method: "POST", json: { items: rows, defaults: project ? { project } : {} } })); onDone(); }
    catch (e) { setError((e as Error).message); }
  }
  return (
    <Sheet title="Importer des contacts" onClose={onClose}>
      <Card>
        <p className="text-sm text-muted">CSV (séparateur virgule ou point-virgule), JSON ou NDJSON. Les colonnes nom, entreprise, téléphone, e-mail, ville, adresse, secteur, site et source sont reconnues. Les doublons (même téléphone, même e-mail, ou même nom dans la même ville) sont ignorés.</p>
        <input type="file" accept=".csv,.json,.ndjson" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} className="mt-4 block text-sm" />
        {rows && (
          <>
            <p className="mt-4 text-sm">{fmt(rows.length)} lignes lues. Aperçu :</p>
            <ul className="mt-2 space-y-1 text-sm text-muted">{sample.map((r, i) => <li key={i} className="truncate">{r.name || "(sans nom)"} · {[r.phone, r.city, r.sector].filter(Boolean).join(" · ")}</li>)}</ul>
            <Field label="Projet à attribuer (facultatif)" className="mt-4"><input value={project} onChange={(e) => setProject(e.target.value)} className={inputCls} placeholder="monprojet, sitevitrine…" /></Field>
            {!result && <Button className="mt-4" onClick={send}>Importer {fmt(rows.length)} contacts</Button>}
          </>
        )}
        {result && <p className="mt-4 text-sm">{fmt(result.added)} ajoutés · {fmt(result.skipped)} doublons ignorés{result.invalid ? ` · ${fmt(result.invalid)} lignes sans nom` : ""}.</p>}
        {error && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
      </Card>
    </Sheet>
  );
}
