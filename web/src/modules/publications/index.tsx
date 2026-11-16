// Module Publications : calendrier, publications à surveiller, comptes et automatisations.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../../App";
import { Button, Card, EmptyBox, Pill, Segmented, Table, fmt, inputCls, useAsk } from "../../ui";
import { PUB_CHIP, PUB_STATE, PUB_STATUS, dateFr, keysOf, projectKey, today, type Go, type ProjectRef, type Pub, type Summary } from "../shared";
import { NET_NAME, NETWORKS } from "../shared";
import { PubEditor } from "./composer";
import { SocialStatsCard } from "./stats";
import { GbpCard } from "./gbp";
import { AutomationCard, RulesCard } from "./automation";

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

const ATTENTION = ["failed", "needs_action", "to_verify", "missed"];
const WATCH = [...ATTENTION, "processing"];

/** Calendrier, à surveiller, comptes et automatisations. Dans la page d'un projet, `project` est fixé. */
export function PubsView({ q, go, project: fixed }: { q: Record<string, string>; go: Go; project?: ProjectRef }) {
  const { data: projects } = useData<ProjectRef[]>("/api/projects?days=1");
  const current = fixed ?? projects?.find((p) => q.project && keysOf(p).includes(q.project));
  const scope = current ? projectKey(current) : undefined;
  const nameOfProject = (key: string | null) => projects?.find((p) => key && keysOf(p).includes(key));
  const month = /^\d{4}-\d{2}$/.test(q.month ?? "") ? q.month : today().slice(0, 7);
  const first = new Date(month + "-01T00:00:00Z");
  const start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 86400000);
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
  const { data, error, reload } = useData<Pub[]>(`/api/publications?from=${days[0]}&to=${days[41]}${scope ? `&project=${encodeURIComponent(scope)}` : ""}`);
  // Fenêtre large : une publication « À vérifier » ou « Manquée » doit rester visible même si elle est ancienne.
  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const { data: watch, reload: reloadWatch } = useData<Pub[]>(`/api/publications?from=${from}&to=${to}${scope ? `&project=${encodeURIComponent(scope)}` : ""}`);
  const { data: accounts, reload: reloadAccounts } = useData<Account[]>("/api/pub-accounts");
  const { data: mods } = useData<{ id: string; enabled: boolean }[]>("/api/modules");
  const [edit, setEdit] = useState<Partial<Pub> | null>(null);

  const tab = fixed ? (q.sub ?? "calendrier") : (q.tab ?? "calendrier");
  const setTab = (v: string) => go(fixed ? { sub: v === "calendrier" ? undefined : v } : { tab: v === "calendrier" ? undefined : v });
  const shift = (n: number) => { const d = new Date(first); d.setUTCMonth(d.getUTCMonth() + n); go({ month: d.toISOString().slice(0, 7) }); };
  const byDay = useMemo(() => (data ?? []).reduce<Record<string, Pub[]>>((m, p) => ((m[p.day] ??= []).push(p), m), {}), [data]);
  const counts = { published: data?.filter((p) => p.day.startsWith(month) && p.status === "published").length ?? 0, planned: data?.filter((p) => p.day.startsWith(month) && p.status !== "published").length ?? 0 };
  const attention = (watch ?? []).filter((p) => ATTENTION.includes(p.state ?? ""));
  const toReconnect = (accounts ?? []).filter((a) => a.status !== "connected");
  const moduleOff = mods?.some((m) => m.id === "publications" && !m.enabled);
  const accountName = (id: string | null | undefined) => accounts?.find((a) => a.id === id)?.label ?? "compte retiré";
  const refresh = () => { reload(); reloadWatch(); reloadAccounts(); };

  const monthButtons = <>
    <Button variant="secondary" onClick={() => shift(-1)} aria-label="Mois précédent">←</Button>
    <Button variant="secondary" onClick={() => go({ month: undefined })}>Aujourd'hui</Button>
    <Button variant="secondary" onClick={() => shift(1)} aria-label="Mois suivant">→</Button>
  </>;

  return (
    <>
      {moduleOff && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-negative/40 bg-negative-bg px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">Le module Publications est désactivé : la file ne tourne pas, rien ne partira.</span>
          <Button variant="secondary" onClick={() => go({ view: "connections" })}>Activer</Button>
        </div>
      )}
      {toReconnect.length > 0 && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-bg px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">{toReconnect.length} compte{toReconnect.length > 1 ? "s" : ""} à reconnecter : {toReconnect.map((a) => a.label).join(", ")}</span>
          <Button variant="secondary" onClick={() => setTab("comptes")}>Reconnecter</Button>
        </div>
      )}
      {attention.length > 0 && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-bg px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">{attention.length} publication{attention.length > 1 ? "s" : ""} demande{attention.length > 1 ? "nt" : ""} votre attention.</span>
          <Button variant="secondary" onClick={() => setTab("surveiller")}>Voir</Button>
        </div>
      )}

      {(() => {
        const sub = `${dateFr(month + "-01", { month: "long", year: "numeric" })} · ${counts.published} publiées, ${counts.planned} prévues`;
        const buttons = <><Button onClick={() => setEdit({ day: today(), project: scope ?? null })}>Nouvelle publication</Button>{monthButtons}</>;
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

      <div className="mb-5 -mt-1 overflow-x-auto">
        <Segmented label="Sections des publications" value={tab} onChange={setTab} options={[["calendrier", "Calendrier"], ["surveiller", `À surveiller${attention.length ? ` (${attention.length})` : ""}`], ["comptes", "Comptes"], ["automatisations", "Automatisations"]] as const} />
      </div>

      {tab === "surveiller" ? (
        <Card title="À surveiller">
          {!watch ? <KpiSkeleton /> : !WATCH.some((s) => watch.some((p) => p.state === s)) ? <EmptyBox>Rien à surveiller : tout est parti ou en brouillon.</EmptyBox> : (
            <ul className="divide-y divide-rule">
              {watch.filter((p) => WATCH.includes(p.state ?? "")).map((p) => {
                const acc = accounts?.find((a) => a.id === p.account_id);
                return <li key={p.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <span className="num w-20 shrink-0 text-muted">{dateFr(p.day)}</span>
                  <button type="button" onClick={() => setEdit(p)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{p.title}</span>
                    <span className="block text-xs text-muted">{accountName(p.account_id)} · {p.network ?? NET_NAME[acc?.network ?? ""] ?? ""}</span>
                  </button>
                  <StatusPill s={p.status} state={p.state} />
                  {(p.state === "failed" || p.state === "needs_action" || p.state === "missed") && <button type="button" onClick={async () => { await api(`/api/publications/${p.id}/retry`, { method: "POST" }).catch(() => {}); refresh(); }} className="text-xs text-ink underline">Réessayer</button>}
                  {p.state === "to_verify" && <button type="button" onClick={() => setEdit(p)} className="text-xs text-ink underline">Vérifier</button>}
                  {acc && acc.status !== "connected" && <button type="button" onClick={() => setTab("comptes")} className="text-xs text-negative underline">Reconnecter</button>}
                </li>;
              })}
            </ul>
          )}
        </Card>
      ) : tab === "comptes" ? (
        <div className="space-y-4">
          <AccountsCard project={current} projects={projects ?? []} />
          <SocialStatsCard project={scope} />
          <GbpCard project={scope} />
        </div>
      ) : tab === "automatisations" ? (
        <div className="space-y-4">
          <AutomationCard project={current ? keysOf(current) : undefined} />
          <RulesCard project={current ? keysOf(current) : undefined} />
        </div>
      ) : (
        <div className="hidden overflow-hidden rounded-2xl border border-border bg-surface md:block">
          {error ? <ErrorLine error={error} retry={reload} /> : !data ? <div className="p-5"><KpiSkeleton /></div> : (
            <>
              <div className="grid grid-cols-7 border-b border-border text-xs text-muted">
                {["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."].map((d) => <div key={d} className="px-3 py-2">{d}</div>)}
              </div>
              <div className="grid grid-cols-7">
                {days.map((d) => (
                  <div key={d} onDoubleClick={() => setEdit({ day: d })}
                    className={`min-h-28 border-r border-b border-rule p-2 [&:nth-child(7n)]:border-r-0 ${d.startsWith(month) ? "" : "bg-ground"}`}>
                    <div className={`num mb-1 text-xs ${d === today() ? "inline-grid size-6 place-items-center rounded-full bg-accent text-on-accent" : "text-muted"}`}>{Number(d.slice(8))}</div>
                    <div className="space-y-1">
                      {byDay[d]?.map((p) => (
                        <button key={p.id} onClick={() => setEdit(p)} title={p.title}
                          className={`block w-full truncate rounded-lg px-2 py-1 text-left text-xs ${PUB_CHIP[p.state ?? (p.status === "published" ? "published" : "draft")] ?? "bg-raised"}`}>
                          {!scope && nameOfProject(p.project) && <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: nameOfProject(p.project)?.color ?? "currentColor" }} />}
                          {p.network && <span className="opacity-70">{p.network} · </span>}{p.title}{p.state && !["published", "draft", "scheduled"].includes(p.state) && <span className="ml-1 font-medium">· {PUB_STATE[p.state]?.[0] ?? p.state}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === "calendrier" && (
        <>
          <Card className="md:hidden">
            {!data ? <KpiSkeleton /> : data.filter((p) => p.day.startsWith(month)).length ? (
              <ul className="divide-y divide-rule">
                {data.filter((p) => p.day.startsWith(month)).map((p) => (
                  <li key={p.id}><button onClick={() => setEdit(p)} className="flex h-12 w-full items-center gap-3 text-left text-sm">
                    <span className="num w-14 shrink-0 text-muted">{dateFr(p.day)}</span><span className="min-w-0 flex-1 truncate">{p.title}{!scope && nameOfProject(p.project) ? <span className="text-muted"> · {nameOfProject(p.project)!.name}</span> : null}</span><StatusPill s={p.status} state={p.state} />
                  </button></li>
                ))}
              </ul>
            ) : <EmptyBox>Rien de prévu ce mois-ci. <button type="button" onClick={() => setEdit({ day: today() })} className="text-ink underline">Planifier une publication</button></EmptyBox>}
          </Card>
          <p className="mt-3 hidden text-xs text-muted md:block">Double-cliquez sur un jour pour y ajouter une publication.</p>
        </>
      )}

      {edit && <PubEditor pub={edit} projects={projects ?? []} defaultProject={scope} onClose={() => setEdit(null)} onSaved={refresh} />}
    </>
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
  const [error, setError] = useState("");
  async function connect(n: Network) {
    setError("");
    try { const r = await api<{ url: string }>(`/api/pub-oauth/${n.id}/start`, { method: "POST", json: { project: connectFor } }); window.location.href = r.url; }
    catch (err) { setError((err as Error).message); }
  }
  const nameOf = (key: string) => projects.find((p) => p.id === key || p.crm_key === key)?.name ?? key;
  const { data: recipes } = useData<{ network: string; validated: string | null }[]>("/api/browser/recipes");
  const { data: mods } = useData<{ id: string; enabled: boolean }[]>("/api/modules");
  const queueOff = mods?.some((m) => m.id === "publications" && !m.enabled);
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
          {networks && !networks.some((n) => n.configured) && <span className="text-sm text-muted">Aucun réseau configuré : Outils → Intégrations donne la marche à suivre pour chacun.</span>}
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
