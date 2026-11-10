// Module Publications : bloc de la semaine et calendrier éditorial.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../../App";
import { Button, Card, EmptyBox, Pill, Segmented, Table, fmt, inputCls } from "../../ui";
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
            ) : <EmptyBox>Rien de prévu ce mois-ci.</EmptyBox>}
          </Card>
          <p className="mt-3 hidden text-xs text-muted md:block">Double-cliquez sur un jour pour y ajouter une publication.</p>
        </>
      )}
      {edit && <PubSheet pub={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

// Lien de suivi : à mettre dans la bio ou la description, il compte les visites amenées par la publication
function TrackingLink({ pub }: { pub: Partial<Pub> }) {
  const { data: sites } = useData<{ domain: string }[]>("/api/sites");
  const [site, setSite] = useState("");
  const [path, setPath] = useState("/");
  const [copied, setCopied] = useState(false);
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
        <Button type="button" variant="secondary" onClick={() => navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? "Copié" : "Copier"}</Button>
      </div>
      <p className="mt-2 text-xs text-muted">Mettez ce lien dans la bio ou la description : chaque visite arrivée par lui est comptée ici (code « {pub.campaign} »).</p>
    </div>
  );
}

function PubSheet({ pub, onClose, onSaved }: { pub: Partial<Pub>; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api(pub.id ? `/api/publications/${pub.id}` : "/api/publications", { method: pub.id ? "PATCH" : "POST", json: Object.fromEntries(new FormData(e.currentTarget)) }); onSaved(); }
    catch (err) { setError((err as Error).message); }
  }
  async function remove() {
    if (!confirm("Supprimer cette publication ?")) return;
    await api(`/api/publications/${pub.id}`, { method: "DELETE" }); onSaved();
  }
  return (
    <Sheet title={pub.id ? "Publication" : "Nouvelle publication"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4 rounded-2xl border border-border bg-surface p-5">
        <Field label="Titre *"><input name="title" required defaultValue={pub.title} className={inputCls} autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date *"><input name="day" type="date" required defaultValue={pub.day} className={inputCls} /></Field>
          <Field label="Statut"><select name="status" defaultValue={pub.status} className={inputCls}>{PUB_STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Projet"><input name="project" defaultValue={pub.project ?? ""} className={inputCls} placeholder="monprojet, monapp…" /></Field>
          <Field label="Réseau"><input name="network" list="reseaux" defaultValue={pub.network ?? ""} className={inputCls} /></Field>
        </div>
        <datalist id="reseaux">{NETWORKS.map((n) => <option key={n} value={n} />)}</datalist>
        <Field label="Lien de la publication"><input name="url" type="url" defaultValue={pub.url ?? ""} className={inputCls} /></Field>
        <Field label="Notes"><textarea name="notes" rows={4} defaultValue={pub.notes ?? ""} className={`${inputCls} h-auto py-2`} /></Field>
        {pub.id && pub.campaign && <TrackingLink pub={pub} />}
        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        <div className="flex items-center justify-between">
          <Button>{pub.id ? "Enregistrer" : "Ajouter"}</Button>
          {pub.id && <button type="button" onClick={remove} className="text-sm text-negative hover:underline">Supprimer</button>}
        </div>
      </form>
    </Sheet>
  );
}
