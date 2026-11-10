// Section « Sources » d'un projet (P6) : quelles connexions alimentent ses indicateurs, rattachement en quelques clics,
// et propriété Search Console de chacun de ses sites (Q-N4 : la propriété est une colonne du site, elle ne crée aucun indicateur).
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useData } from "./App";
import { useCatalog, useDrawerKeys, type Catalog, type Manifest } from "./connections";
import { Button, Card, EmptyBox, inputCls, restoreFocus } from "./ui";

type Go = (n: Record<string, string | undefined>) => void;
type Sources = {
  groups: { connection: { id: string; kind: string; label: string; hint: string; status: "connected" | "error" | "reconnect"; name: string; monogram: string } | null; indicators: { id: string; label: string; error: string | null }[] }[];
  legacy: { id: string; label: string; error: string | null; via: string }[];
  sites: { id: string; domain: string; gsc_property: string | null }[];
  google: boolean; productDb: boolean;
};
const STATUS = { connected: ["● Connecté", "text-positive"], error: ["● Erreur", "text-negative"], reconnect: ["● À reconnecter", "text-negative"] } as const;
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;

export function SourcesCard({ projectId, onChanged, go }: { projectId: string; onChanged: () => void; go: Go }) {
  const { data: s, reload } = useData<Sources>(`/api/projects/${projectId}/sources`);
  const { catalog, reload: reloadCatalog } = useCatalog();
  const [attach, setAttach] = useState(false);
  const [adding, setAdding] = useState(false);
  const [props, setProps] = useState<string[] | null>(null);
  const [msg, setMsg] = useState("");
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => { if (s?.google) api<string[]>("/api/gsc/properties").then(setProps).catch(() => setProps([])); }, [s?.google]);

  async function setProperty(siteId: string, value: string) {
    setMsg("");
    try { await api(`/api/sites/${siteId}`, { method: "PATCH", json: { gsc_property: value || null } }); reload(); onChanged(); }
    catch (e) { setMsg((e as Error).message); }
  }
  const done = (created: number, skipped: string[]) => {
    setAttach(false); reload(); onChanged();
    setMsg(`${plural(created, "indicateur")} ajouté${created > 1 ? "s" : ""}${skipped.length ? ` · déjà présent${skipped.length > 1 ? "s" : ""} : ${skipped.join(", ")}` : ""}.`);
  };
  // Le focus revient au bouton qui a ouvert le panneau, après son démontage
  useEffect(() => { if (!attach && !adding) return restoreFocus(opener.current); }, [attach, adding]);
  if (!s) return null;
  const empty = !s.groups.length && !s.legacy.length;

  return (
    <Card title="Sources" action={<span className="flex flex-wrap gap-2">
      <Button onClick={(e) => { opener.current = e.currentTarget; setAdding(true); }}>Ajouter des KPI</Button>
      <Button variant="secondary" onClick={(e) => { opener.current = e.currentTarget; setAttach(true); }}>Rattacher</Button>
    </span>}>
      {empty && <EmptyBox>Aucune source rattachée. « Rattacher » relie une connexion (Stripe, Postgres, PageSpeed…) et crée les indicateurs en quelques clics.</EmptyBox>}
      <ul className="divide-y divide-rule">
        {s.groups.map((g, i) => {
          const bad = g.indicators.filter((x) => x.error).length;
          return (
            <li key={g.connection?.id ?? `retiree-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-xs text-muted">{g.connection?.monogram ?? "—"}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{g.connection ? `${g.connection.name} · ${g.connection.label}` : "Source retirée"}</span>
                <span className="block truncate text-xs text-muted">{plural(g.indicators.length, "indicateur")}{bad ? ` · ${bad} en erreur` : ""} · {g.indicators.map((x) => x.label).join(", ")}</span>
              </span>
              {g.connection
                ? <span className={`text-xs ${STATUS[g.connection.status][1]}`}>{STATUS[g.connection.status][0]}</span>
                : <span className="text-xs text-negative">● Source retirée</span>}
            </li>
          );
        })}
        {s.legacy.length > 0 && (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-xs text-muted">.env</span>
            <span className="min-w-0 flex-1">
              <span className="block">Variables d'environnement <span className="rounded bg-raised px-1.5 py-0.5 text-xs text-muted">via .env</span></span>
              <span className="block truncate text-xs text-muted">{plural(s.legacy.length, "indicateur")} · {s.legacy.map((x) => x.label).join(", ")} · « Gérer le projet » → « Modifier » → « Passer sur une connexion »</span>
            </span>
          </li>
        )}
        {s.sites.map((site) => (
          <li key={site.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-sm">
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-xs text-muted">GO</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">Search Console · {site.domain}</span>
              <span className="block truncate text-xs text-muted">{site.gsc_property ?? "Non rattaché"}</span>
            </span>
            {s.google && props ? (
              <select aria-label={`Propriété Search Console de ${site.domain}`} value={site.gsc_property ?? ""} onChange={(e) => setProperty(site.id, e.target.value)} className={`${inputCls} w-full max-w-[16rem] sm:w-auto`}>
                <option value="">Non rattaché</option>
                {[...new Set([...(site.gsc_property ? [site.gsc_property] : []), ...props])].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : !site.gsc_property && <button type="button" onClick={() => go({ view: "connections", id: undefined, site: undefined })} className="text-xs text-accent underline">Connecter Google</button>}
          </li>
        ))}
      </ul>
      {!s.sites.length && <p className="mt-3 text-xs text-muted">Ajoutez d'abord un site au projet pour rattacher Search Console (« Gérer le projet »).</p>}
      {!s.productDb && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          Aucune base produit : rattachez Postgres pour suivre inscriptions et rétention.
          <button type="button" onClick={(e) => { opener.current = e.currentTarget; setAttach(true); }} className="text-accent underline">Rattacher</button>
        </p>
      )}
      {msg && <p role="status" className="mt-3 text-sm">{msg}</p>}
      {adding && <KpiCatalogPanel projectId={projectId} onClose={() => setAdding(false)} onAdded={(label) => { reload(); onChanged(); setMsg(`« ${label} » ajouté.`); }} />}
      {attach && catalog && <AttachPanel projectId={projectId} catalog={catalog} onClose={() => setAttach(false)} onDone={done} go={go} reloadCatalog={reloadCatalog} />}
    </Card>
  );
}

type Row = { i: number; label: string; kpi: NonNullable<Manifest["kpis"]>[number]; sql?: string };

function AttachPanel({ projectId, catalog, onClose, onDone, go }: { projectId: string; catalog: Catalog; onClose: () => void; onDone: (n: number, skipped: string[]) => void; go: Go; reloadCatalog: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDrawerKeys(ref, onClose);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const choices = catalog.connectors.filter((c) => c.hasKpis && c.connections.length).flatMap((c) => c.connections.map((x) => ({ m: c, c: x })));
  const [pick, setPick] = useState<string | null>(null);
  const chosen = choices.find((x) => x.c.id === pick);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [shared, setShared] = useState<Record<string, string>>({});
  const [sqls, setSqls] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const rows: Row[] = (chosen?.m.presets ?? []).flatMap((p, i) => {
    const kpi = chosen!.m.kpis?.find((k) => k.id === p.kpi);
    return kpi ? [{ i, label: p.label, kpi, sql: p.params?.sql }] : [];
  });
  const select = (id: string) => {
    const m = choices.find((x) => x.c.id === id)!.m;
    setPick(id); setError(""); setShared({});
    const on = ["stripe", "pagespeed", "google"].includes(m.id);
    setChecked(Object.fromEntries((m.presets ?? []).map((_, i) => [i, on])));
    setSqls(Object.fromEntries((m.presets ?? []).map((p, i) => [i, p.params?.sql ?? ""])));
  };
  const on = rows.filter((r) => checked[r.i]);
  // Paramètres communs (URL, appareil, package, chemin) saisis une fois ; les requêtes SQL restent propres à chaque ligne
  const common = new Map<string, NonNullable<Manifest["kpis"]>[number]["params"] extends (infer F)[] | undefined ? F : never>();
  for (const r of on) for (const f of r.kpi.params ?? []) if (f.type !== "textarea" && !common.has(f.key)) common.set(f.key, f);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const items = on.map((r) => ({ kpi: r.kpi.id, label: r.label, params: { ...shared, ...((r.kpi.params ?? []).some((f) => f.type === "textarea") ? { sql: sqls[r.i] } : {}) } }));
      const out = await api<{ created: unknown[]; skipped: string[] }>(`/api/projects/${projectId}/sources`, { method: "POST", json: { connection_id: pick, items } });
      onDone(out.created.length, out.skipped);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="attach-title" className="relative flex h-full w-full max-w-full flex-col overflow-y-auto overflow-x-hidden bg-surface p-5 shadow-2xl sm:max-w-[30rem] sm:border-l sm:border-border sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 id="attach-title" className="text-xl font-light">Rattacher une source</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Fermer" className="grid size-10 shrink-0 place-items-center rounded-full border border-control text-muted hover:text-ink">✕</button>
        </div>
        {!choices.length ? (
          <div className="mt-6 space-y-3 text-sm">
            <p className="text-muted">Aucune connexion ne fournit d'indicateur pour l'instant. Branchez Stripe, Postgres, PageSpeed, Google ou une API JSON, puis revenez ici.</p>
            <Button variant="accent" onClick={() => go({ view: "connections", id: undefined, site: undefined })}>Ouvrir Connexions</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-5">
            <fieldset>
              <legend className="text-sm font-medium">1. Choisissez une connexion</legend>
              <div className="mt-3 space-y-2">
                {choices.map(({ m, c }) => (
                  <label key={c.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm ${pick === c.id ? "border-accent" : "border-border"}`}>
                    <input type="radio" name="connexion" value={c.id} checked={pick === c.id} onChange={() => select(c.id)} className="mt-1 accent-[var(--color-accent)]" />
                    <span className="min-w-0"><span className="block break-words">{m.name} · {c.label}</span><span className="block break-words font-mono text-xs text-muted">{c.hint}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            {chosen && (
              <>
                <fieldset>
                  <legend className="text-sm font-medium">2. Cochez les indicateurs à créer</legend>
                  <div className="mt-3 space-y-3">
                    {rows.map((r) => (
                      <div key={r.i} className="rounded-xl border border-border px-3 py-2.5">
                        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={!!checked[r.i]} onChange={(e) => setChecked({ ...checked, [r.i]: e.target.checked })} className="mt-1 size-4 accent-[var(--color-accent)]" /><span>{r.label}<span className="ml-2 text-xs text-muted">{r.kpi.mode === "daily" ? "par jour" : "niveau"}</span></span></label>
                        {checked[r.i] && (r.kpi.params ?? []).some((f) => f.type === "textarea") && (
                          <label className="mt-2 block text-xs text-muted">Requête SQL (un seul SELECT, à adapter à vos tables)
                            <textarea value={sqls[r.i] ?? ""} onChange={(e) => setSqls({ ...sqls, [r.i]: e.target.value })} rows={3} spellCheck={false} className={`${inputCls} mt-1 h-auto py-2 font-mono text-xs`} />
                          </label>
                        )}
                      </div>
                    ))}
                  </div>
                  {chosen.m.id === "google" && <p className="mt-3 text-xs leading-5 text-muted">Search Console ne crée pas d'indicateur : choisissez la propriété de chaque site dans la liste « Sources » du projet. Ici : Google Play (nom du package ci-dessous).</p>}
                </fieldset>
                {on.length > 0 && common.size > 0 && (
                  <div className="space-y-3">
                    {[...common.values()].map((f) => (
                      <label key={f.key} className="block text-sm">{f.label}{f.required ? " *" : ""}
                        {f.type === "select"
                          ? <select value={shared[f.key] ?? f.default ?? ""} onChange={(e) => setShared({ ...shared, [f.key]: e.target.value })} className={`${inputCls} mt-2`}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                          : <input value={shared[f.key] ?? ""} onChange={(e) => setShared({ ...shared, [f.key]: e.target.value })} placeholder={f.placeholder} required={f.required} type={f.type === "url" ? "url" : "text"} className={`${inputCls} mt-2`} />}
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
            {error && <p role="alert" className="rounded-xl bg-negative-bg px-3 py-2 text-sm text-negative">{error}</p>}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="accent" disabled={busy || !on.length}>{busy ? "Ajout…" : "Ajouter les indicateurs"}</Button>
              <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

type Offer = { module: string; connection_id: string | null; kpi: string; label: string; unit?: string; already?: boolean; values?: Record<string, string>;
  params?: { key: string; label: string; type: string; required?: boolean; placeholder?: string; default?: string }[] };
type KpiGroup = { module: string; name: string; offers: Offer[] };

/** Catalogue de KPI du projet (spec §5.3) : tout ce que ses modules actifs savent mesurer, ajoutable en un clic. */
export function KpiCatalogPanel({ projectId, onClose, onAdded }: { projectId: string; onClose: () => void; onAdded: (label: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDrawerKeys(ref, onClose);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const { data: groups, reload } = useData<KpiGroup[]>(`/api/projects/${projectId}/kpi-catalog`);
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const keyOf = (o: Offer) => `${o.module}:${o.connection_id ?? ""}:${o.kpi}:${JSON.stringify(o.values ?? {})}`;
  const needsInput = (o: Offer) => o.kpi === "manual" || o.kpi === "formula" || (o.params ?? []).some((f) => f.required);

  async function add(o: Offer, extra: Record<string, string> = {}) {
    setError("");
    try {
      const params = { ...o.values, ...values, ...extra };
      const ind = await api<{ label: string }>(`/api/projects/${projectId}/kpis`, { method: "POST", json: { module: o.module, connection_id: o.connection_id, kpi: o.kpi, params, label: o.kpi === "manual" || o.kpi === "formula" ? params.label : undefined } });
      setOpen(null); setValues({}); reload(); onAdded(ind.label);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="kpi-title" className="relative flex h-full w-full max-w-full flex-col overflow-y-auto overflow-x-hidden bg-surface p-5 shadow-2xl sm:max-w-[30rem] sm:border-l sm:border-border sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 id="kpi-title" className="text-xl font-light">Ajouter des KPI</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Fermer" className="grid size-10 shrink-0 place-items-center rounded-full border border-control text-muted hover:text-ink">✕</button>
        </div>
        <p className="mt-2 text-sm text-muted">Ce que les modules actifs de ce projet savent mesurer. Activez d'autres modules pour en voir davantage.</p>
        {error && <p role="alert" className="mt-4 rounded-xl bg-negative-bg px-3 py-2 text-sm text-negative">{error}</p>}
        <div className="mt-5 space-y-6">
          {(groups ?? []).map((g) => (
            <section key={g.module}>
              <h3 className="text-sm font-medium">{g.name}</h3>
              <ul className="mt-2 divide-y divide-rule">
                {g.offers.map((o) => {
                  const k = keyOf(o);
                  return (
                    <li key={k} className="py-2.5 text-sm">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 break-words">{o.label}</span>
                        {o.already ? <span className="text-xs text-muted">Déjà suivi</span>
                          : <Button variant="secondary" onClick={() => needsInput(o) ? (setOpen(open === k ? null : k), setValues({})) : add(o)}>Ajouter</Button>}
                      </div>
                      {open === k && o.kpi === "formula" && <FormulaForm projectId={projectId} onSubmit={(p) => add(o, p)} />}
                      {open === k && o.kpi !== "formula" && (
                        <form onSubmit={(e) => { e.preventDefault(); add(o); }} className="mt-2 space-y-2">
                          {(o.kpi === "manual" ? [{ key: "label", label: "Nom", type: "text", required: true, placeholder: "Abonnés Instagram" }] : (o.params ?? []).filter((f) => f.required)).map((f) => (
                            <label key={f.key} className="block text-xs text-muted">{f.label} *
                              {f.type === "textarea"
                                ? <textarea required value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} rows={3} spellCheck={false} className={`${inputCls} mt-1 h-auto py-2 font-mono text-xs`} />
                                : <input required value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} className={`${inputCls} mt-1`} />}
                            </label>
                          ))}
                          <Button type="submit" variant="accent">Ajouter</Button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const OPS = [["+", "plus"], ["-", "moins"], ["*", "fois"], ["/", "divisé par"]] as const;

/** KPI calculé : deux à six indicateurs du projet combinés (ex. inscriptions divisé par visites, en %). */
function FormulaForm({ projectId, onSubmit }: { projectId: string; onSubmit: (params: Record<string, string>) => void }) {
  const { data: project } = useData<{ indicators: { id: string; label: string; source: string }[] }>(`/api/projects/${projectId}`);
  const inds = (project?.indicators ?? []).filter((i) => i.source !== "formula");
  const [label, setLabel] = useState("");
  const [terms, setTerms] = useState<{ indicator: string; op: string }[]>([{ indicator: "", op: "+" }, { indicator: "", op: "/" }]);
  const [pct, setPct] = useState(true);
  const set = (i: number, patch: Partial<{ indicator: string; op: string }>) => setTerms(terms.map((t, k) => k === i ? { ...t, ...patch } : t));
  if (inds.length < 2) return <p className="mt-2 text-xs text-muted">Il faut au moins deux indicateurs sur ce projet pour en calculer un troisième.</p>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ label, terms: JSON.stringify(terms), ...(pct ? { scale: "100", unit: "%" } : {}) }); }} className="mt-2 space-y-2">
      <label className="block text-xs text-muted">Nom *<input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Taux de conversion" className={`${inputCls} mt-1`} /></label>
      {terms.map((t, i) => (
        <div key={i} className="flex gap-2">
          {i > 0 && <select aria-label={`Opération ${i}`} value={t.op} onChange={(e) => set(i, { op: e.target.value })} className={`${inputCls} w-32 shrink-0`}>{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
          <select required aria-label={`Indicateur ${i + 1}`} value={t.indicator} onChange={(e) => set(i, { indicator: e.target.value })} className={`${inputCls} min-w-0 flex-1`}>
            <option value="">Choisir un indicateur</option>{inds.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {terms.length < 6 && <button type="button" onClick={() => setTerms([...terms, { indicator: "", op: "+" }])} className="text-accent hover:underline">Ajouter un terme</button>}
        <label className="flex items-center gap-2 text-muted"><input type="checkbox" checked={pct} onChange={(e) => setPct(e.target.checked)} className="size-4" />Afficher en %</label>
      </div>
      <Button type="submit" variant="accent">Ajouter</Button>
    </form>
  );
}
