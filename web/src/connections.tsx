// Connexions : le catalogue des services que l'on branche à Searchtide. Une carte = un service, un statut, une action.
// Le contenu des cartes et du formulaire vient du serveur (/api/connectors) : ajouter un connecteur n'exige aucun écran.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDrawerKeys } from "./useDrawerKeys";
import { api } from "./api";
import { Button, Card, UndoBar, copyText, inputCls, restoreFocus } from "./ui";

export type Field = { key: string; label: string; type: "text" | "url" | "number" | "select" | "json" | "textarea"; secret?: boolean; required?: boolean; help?: string; placeholder?: string; options?: { value: string; label: string }[]; default?: string; generate?: "topic" };
export type Conn = { id: string; kind: string; label: string; hint: string; settings: Record<string, string>; status: "connected" | "error" | "reconnect"; status_detail: string | null; tested_at: number | null; livemode: boolean; test_mode: boolean };
export type Manifest = {
  id: string; name: string; monogram: string; provider: string; description: string; category: string; minutes: number; singleton?: boolean; builtin?: boolean;
  unlocks: string[]; fields: Field[]; guide: { text: string; url?: string }[]; revokeUrl?: string; connections: Conn[];
  hasKpis?: boolean; kpis?: { id: string; label: string; mode: "daily" | "total"; unit?: string; params?: Field[] }[]; presets?: { kpi: string; label: string; params?: Record<string, string> }[]; status: "none" | "builtin" | "connected" | "error" | "reconnect";
};
type Usage = { label: string; provider: string; revokeUrl: string | null; indicators: { id: string; label: string; project: string | null }[] };
export type Catalog = { vault: { ok: boolean; message: string | null }; demo: boolean; admin: boolean; connectors: Manifest[]; later: string[] };
type Outcome = { kind: "ok" | "error"; text: string; detail?: string; warnings?: string[]; copy?: { label: string; value: string } };

/** Sujet ntfy aléatoire (il sert de mot de passe) : 96 bits issus du générateur sécurisé du navigateur. */
const genTopic = () => `searchtide-${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const initial = (fields: Field[]) => Object.fromEntries(fields.map((f) => [f.key, f.generate === "topic" ? genTopic() : f.default ?? ""]));

const FILTERS = [["all", "Tous"], ["revenus", "Revenus"], ["seo", "SEO"], ["produit", "Produit"], ["alertes", "Alertes"]] as const;

const STATUS: Record<Manifest["status"], { text: (n: number) => string; tone: "positive" | "negative" | "neutral" }> = {
  none: { text: () => "Non connecté", tone: "neutral" },
  builtin: { text: () => "Intégré", tone: "neutral" },
  connected: { text: (n) => `Connecté · ${n} compte${n > 1 ? "s" : ""}`, tone: "positive" },
  error: { text: () => "Erreur", tone: "negative" },
  reconnect: { text: () => "À reconnecter", tone: "negative" },
};
const CONN_TEXT = { connected: "Connecté", error: "Erreur", reconnect: "À reconnecter" } as const;

function StatusPill({ m }: { m: Manifest }) {
  const s = STATUS[m.status];
  const look = s.tone === "positive" ? "bg-positive-bg text-positive" : s.tone === "negative" ? "bg-negative-bg text-negative" : "bg-raised text-muted";
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ${look}`}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />{s.text(m.connections.length)}
    </span>
  );
}

const ago = (t: number | null) => {
  if (!t) return "jamais testé";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "testé à l'instant" : m < 60 ? `testé il y a ${m} min` : m < 1440 ? `testé il y a ${Math.round(m / 60)} h` : `testé il y a ${Math.round(m / 1440)} j`;
};

/** Piège le focus dans le tiroir ; Échap le ferme. */

function FieldInput({ f, value, onChange, editing }: { f: Field; value: string; onChange: (v: string) => void; editing: boolean }) {
  const [shown, setShown] = useState(false);
  const id = `f-${f.key}`;
  const help = editing && f.secret ? "Laisser vide pour garder la clé actuelle." : f.help;
  const common = `${inputCls} font-mono text-xs`;
  const readFile = async (file?: File) => { if (file) onChange(await file.text()); };
  return (
    <div>
      <label htmlFor={id} className="block text-sm">{f.label}{f.required && !editing ? " *" : ""}</label>
      {f.type === "select" ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} mt-2`}>
          <option value="">—</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : f.type === "json" || f.type === "textarea" ? (
        <>
          <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={4} spellCheck={false} autoComplete="off"
            placeholder={editing && f.secret ? "••••••••" : f.placeholder} className={`${common} mt-2 h-auto w-full py-2`} />
          {f.type === "json" && <label className="mt-2 inline-block cursor-pointer text-xs text-ink underline">Choisir un fichier .json
            <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} /></label>}
        </>
      ) : (
        <div className="mt-2 flex gap-2">
          <input id={id} value={value} onChange={(e) => onChange(e.target.value)} type={f.secret && !shown ? "password" : f.type === "number" ? "number" : f.type === "url" ? "url" : "text"}
            autoComplete="off" spellCheck={false} placeholder={editing && f.secret ? "••••••••" : f.placeholder} className={`${f.secret ? common : inputCls} min-w-0`} />
          {f.secret && <button type="button" onClick={() => setShown(!shown)} aria-pressed={shown} className="shrink-0 rounded-lg border border-control px-3 text-xs text-muted hover:text-ink">{shown ? "Masquer" : "Afficher"}</button>}
        </div>
      )}
      {help && <p className="mt-1.5 text-xs leading-5 text-muted">{help}</p>}
    </div>
  );
}

/** Copie une valeur non secrète (adresse du compte de service Google) avec annonce lecteur d'écran. */
function CopyText({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    setError(""); setDone(false);
    const ok = await copyText(value);
    if (ok) { setDone(true); setTimeout(() => setDone(false), 1500); }
    else setError("Copie impossible ici, sélectionnez l'adresse");
  }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 align-middle">
      <code className="min-w-0 break-all rounded bg-raised px-2 py-0.5 font-mono text-xs text-ink">{value}</code>
      <button type="button" title="Copier l'adresse" onClick={copy}
        className="shrink-0 rounded-lg border border-control px-2.5 py-0.5 text-xs">{done ? "Copié" : "Copier"}</button>
      {error && <span role="status" aria-live="polite" className="text-xs text-negative">{error}</span>}
      <span role="status" aria-live="polite" className="sr-only">{done ? "Copié" : ""}</span>
    </span>
  );
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function Drawer({ m, catalog, onClose, reload }: { m: Manifest; catalog: Catalog; onClose: () => void; reload: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => initial(m.fields));
  const [editing, setEditing] = useState<Conn | null>(null);
  const [label, setLabel] = useState("");
  const [confirmRm, setConfirmRm] = useState<{ conn: Conn; usage: Usage } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Le focus entre dans la confirmation : tout de suite, puis 60 ms plus tard, car Chromium déplace lui-même le focus
  // (sur « Fermer » du tiroir) un ou deux cycles après l'insertion du dialogue et écrasait le premier essai.
  useEffect(() => {
    if (!confirmRm) return;
    cancelRef.current?.focus();
    const id = window.setTimeout(() => cancelRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [confirmRm]);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  useDrawerKeys(ref, onClose);
  useLayoutEffect(() => { closeRef.current?.focus(); }, []); // le focus entre dans le tiroir dès son affichage

  const locked = catalog.demo || !catalog.vault.ok;
  const showForm = !locked && (editing || !(m.singleton && m.connections.length));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setOut(null);
    try {
      const r = editing
        ? await api<{ test: { label?: string; detail?: string; warnings: string[] } }>(`/api/connections/${editing.id}`, { method: "PATCH", json: { values, label } })
        : await api<{ test: { label?: string; detail?: string; warnings: string[] } }>("/api/connections", { method: "POST", json: { kind: m.id, values, label } });
      const gen = m.fields.find((f) => f.generate);
      setOut({ kind: "ok", text: `Connecté : ${r.test.label ?? m.name}`, detail: r.test.detail, warnings: r.test.warnings, ...(gen && !editing ? { copy: { label: gen.label, value: values[gen.key] } } : {}) });
      setValues(initial(m.fields)); setEditing(null); setLabel("");
      await reload();
    } catch (err) { setOut({ kind: "error", text: (err as Error).message }); } finally { setBusy(false); }
  }
  async function retest(c: Conn) {
    setBusy(true); setOut(null);
    try {
      const r = await api<{ ok: boolean; error?: string; label?: string; detail?: string; warnings?: string[] }>(`/api/connections/${c.id}/test`, { method: "POST", json: {} }).catch((e) => ({ ok: false, error: (e as Error).message }) as any);
      setOut(r.ok ? { kind: "ok", text: `Connecté : ${r.label ?? c.label}`, detail: r.detail, warnings: r.warnings } : { kind: "error", text: r.error ?? "Test échoué" });
      await reload();
    } finally { setBusy(false); }
  }
  // Retrait en deux temps : la confirmation cite les indicateurs qui perdront leur source (P5)
  async function askRemove(c: Conn) {
    setOut(null);
    try { setConfirmRm({ conn: c, usage: await api<Usage>(`/api/connections/${c.id}/usage`) }); }
    catch (e) { setOut({ kind: "error", text: (e as Error).message }); }
  }
  const [copyFailed, setCopyFailed] = useState(false);
  const [undo, setUndo] = useState<{ id: string; label: string; timer: number } | null>(null);
  const [hiddenConns, setHiddenConns] = useState<string[]>([]);
  const outRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (out?.kind === "error") outRef.current?.focus(); }, [out]);
  function doRemove() {
    if (!confirmRm) return;
    const { conn, usage } = confirmRm;
    setConfirmRm(null);
    setHiddenConns((h) => [...h, conn.id]);
    // B8 : la suppression part après 5 s ; « Annuler » l'empêche.
    const timer = window.setTimeout(async () => {
      try {
        const r = await api<{ relayWarning?: boolean }>(`/api/connections/${conn.id}`, { method: "DELETE" });
        setOut({ kind: "ok", text: `« ${conn.label} » est retiré.`, detail: `${usage.indicators.length ? `${usage.indicators.length} indicateur${usage.indicators.length > 1 ? "s" : ""} passe${usage.indicators.length > 1 ? "nt" : ""} en « Source retirée », historique conservé. ` : ""}${r.relayWarning ? "Révoquée ici ; retirez aussi l'application dans votre Dashboard Stripe." : ""}`.trim() });
        await reload();
      } catch (e) { setOut({ kind: "error", text: (e as Error).message }); }
      finally { setUndo(null); setHiddenConns((h) => h.filter((x) => x !== conn.id)); }
    }, 5000);
    setUndo({ id: conn.id, label: conn.label, timer });
  }
  function cancelRemove() {
    if (!undo) return;
    window.clearTimeout(undo.timer);
    setHiddenConns((h) => h.filter((x) => x !== undo.id));
    setUndo(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="drawer-title"
        className="relative flex h-full w-full max-w-full flex-col overflow-y-auto overflow-x-hidden bg-surface p-5 shadow-2xl sm:max-w-[30rem] sm:border-l sm:border-border sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="drawer-title" className="text-xl font-light break-words">{m.name}</h2>
            <div className="mt-2"><StatusPill m={m} /></div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Fermer" className="grid size-10 shrink-0 place-items-center rounded-full border border-control text-muted hover:text-ink">✕</button>
        </div>
        <p className="mt-4 text-sm leading-6 text-muted">{m.description}</p>
        <p className="mt-3 text-sm"><span className="text-muted">Ce que ça débloque : </span>{m.unlocks.join(" · ")}</p>

        {!catalog.vault.ok && <p role="alert" className="mt-4 rounded-xl bg-negative-bg px-3 py-2 text-sm text-negative">{catalog.vault.message}</p>}
        {catalog.demo && <p className="mt-4 rounded-xl bg-raised px-3 py-2 text-sm text-muted">Désactivé en démonstration.</p>}

        {m.guide.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium">Guide</h3>
            <ol className="mt-3 space-y-2.5 text-sm leading-6">
              {m.guide.map((g, i) => (
                <li key={i} className="flex gap-3"><span aria-hidden className="num mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-raised text-xs text-muted">{i + 1}</span>
                  <span className="min-w-0 break-words">{g.text}{g.url && <> <a href={g.url} target="_blank" rel="noreferrer noopener" className="whitespace-nowrap text-ink underline">Ouvrir ↗</a></>}</span></li>
              ))}
            </ol>
          </div>
        )}

        {showForm && (
          <form onSubmit={submit} className="mt-6 space-y-4 border-t border-rule pt-6">
            <h3 className="text-sm font-medium">{editing ? `Remplacer la clé de « ${editing.label} »` : "Connexion"}</h3>
            {!m.singleton && (
              <div>
                <label htmlFor="f-label" className="block text-sm">Libellé (facultatif)</label>
                <input id="f-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoComplete="off" placeholder="Pour reconnaître ce compte" className={`${inputCls} mt-2`} />
              </div>
            )}
            {m.fields.map((f) => <FieldInput key={f.key} f={f} value={values[f.key] ?? ""} onChange={(v) => setValues({ ...values, [f.key]: v })} editing={!!editing} />)}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="accent" disabled={busy}>{busy ? "Test en cours…" : "Tester et enregistrer"}</Button>
              {editing && <Button type="button" variant="secondary" onClick={() => { setEditing(null); setLabel(""); setOut(null); }}>Annuler</Button>}
            </div>
          </form>
        )}

        <div aria-live="polite" className="mt-4">
          {out && (
            <div ref={outRef} tabIndex={-1} role={out.kind === "error" ? "alert" : "status"} className={`rounded-xl px-3 py-2 text-sm ${out.kind === "error" ? "bg-negative-bg text-negative" : "bg-positive-bg text-positive"}`}>
              {out.kind === "error" && <a className="mr-2 underline" href="https://github.com/Nadir-DNA/searchtide/blob/main/docs/guides/faq.md" target="_blank" rel="noreferrer">Que faire ?</a>}
              <p className="break-words">{out.text}</p>
              {out.detail && <p className="mt-1 break-words text-xs">{out.detail}</p>}
              {out.warnings?.map((w, i) => {
                const email = m.id === "google" ? w.match(EMAIL)?.[0] : undefined;
                if (!email) return <p key={i} className="mt-1 break-words text-xs text-ink">⚠ {w}</p>;
                const [before, after] = w.split(email);
                return <p key={i} className="mt-1 break-words text-xs text-ink">⚠ {before}<CopyText value={email} />{after}</p>;
              })}
              {out.copy && (
                <div className="mt-2 flex items-center gap-2 text-ink">
                  <code className="min-w-0 flex-1 rounded bg-raised px-2 py-1 font-mono text-xs break-all" aria-label={out.copy.label}>{out.copy.value}</code>
                  <button type="button" onClick={async () => { const ok = await copyText(out.copy!.value); setCopyFailed(!ok); setTimeout(() => setCopyFailed(false), 2000); }} className="shrink-0 rounded-lg border border-control px-3 py-1 text-xs">Copier</button>
                  {copyFailed && <span role="status" className="text-xs text-negative">Copie impossible : sélectionnez le texte.</span>}
                </div>
              )}
            </div>
          )}
        </div>

        {undo && <UndoBar text={`« ${undo.label} » supprimé dans 5 s.`} onUndo={cancelRemove} />}
        {confirmRm && (
          <div role="alertdialog" aria-modal="false" aria-labelledby="rm-title" className="mt-6 rounded-xl border border-negative bg-negative-bg p-4 text-sm">
            <h3 id="rm-title" className="font-medium">Retirer « {confirmRm.conn.label} » ?</h3>
            <p className="mt-2 leading-6">
              {confirmRm.usage.indicators.length
                ? <>{confirmRm.usage.indicators.length} indicateur{confirmRm.usage.indicators.length > 1 ? "s" : ""} l'utilise{confirmRm.usage.indicators.length > 1 ? "nt" : ""} : {confirmRm.usage.indicators.map((i) => i.project ? `${i.label} (${i.project})` : i.label).join(", ")}. Leur historique est conservé, ils ne seront plus relevés.</>
                : <>Aucun indicateur ne l'utilise.</>}
              {" "}Pensez aussi à supprimer la clé chez {confirmRm.usage.provider}{confirmRm.usage.revokeUrl && <> : <a href={confirmRm.usage.revokeUrl} target="_blank" rel="noreferrer noopener" className="underline">ouvrir ↗</a></>}.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" onClick={doRemove} className="h-9 rounded-full bg-negative px-4 text-sm font-medium text-ground">Retirer définitivement</button>
              <button ref={cancelRef} type="button" onClick={() => setConfirmRm(null)} className="h-9 rounded-full border border-control px-4 text-sm">Annuler</button>
            </div>
          </div>
        )}

        {m.connections.length > 0 && (
          <div className="mt-6 border-t border-rule pt-6">
            <h3 className="text-sm font-medium">Comptes connectés</h3>
            <ul className="mt-3 divide-y divide-rule">
              {m.connections.filter((c) => !hiddenConns.includes(c.id)).map((c) => (
                <li key={c.id} className="py-3">
                  <p className="break-words text-sm">{c.label}{c.test_mode && <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">test</span>}</p>
                  {m.id === "google" && EMAIL.test(c.hint)
                    ? <p className="mt-0.5 break-words text-xs text-muted"><CopyText value={c.hint} /></p>
                    : <p className="mt-0.5 break-words font-mono text-xs text-muted">{c.hint}</p>}
                  <p className={`mt-1 text-xs ${c.status === "connected" ? "text-positive" : "text-negative"}`}>● {CONN_TEXT[c.status]} <span className="text-muted">· {ago(c.tested_at)}</span></p>
                  {c.status_detail && <p className="mt-1 break-words text-xs text-negative">{c.status_detail}</p>}
                  {!catalog.demo && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <button type="button" disabled={busy} onClick={() => retest(c)} className="py-1 text-ink underline">Tester</button>
                      <button type="button" onClick={() => { setEditing(c); setLabel(c.label); setOut(null); setValues(Object.fromEntries(m.fields.map((f) => [f.key, f.secret ? "" : String(c.settings?.[f.key] ?? f.default ?? "")]))); }} className="py-1 text-ink underline">Remplacer la clé</button>
                      <button type="button" onClick={() => askRemove(c)} className="py-1 text-muted hover:text-negative">Retirer</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectorCard({ m, onOpen, cardRef }: { m: Manifest; onOpen: () => void; cardRef?: (el: HTMLButtonElement | null) => void }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-raised text-sm font-medium text-muted">{m.monogram}</span>
          <h3 className="flex min-h-10 min-w-0 items-center text-base font-light break-words">{m.name}</h3>
        </div>
        <StatusPill m={m} />
      </div>
      <p className="mt-3 text-sm leading-5 break-words text-muted">{m.unlocks.join(" · ")}</p>
      <p className="mt-auto flex items-center justify-between gap-3 pt-3 text-xs text-muted">
        <span>{m.builtin ? "Toujours disponible" : `~${m.minutes} min`}</span>
        {!m.builtin && <span className="text-sm text-ink">{m.connections.length ? "Gérer" : "Connecter"}</span>}
      </p>
    </>
  );
  const cls = "flex h-full w-full min-w-0 flex-col items-stretch justify-start rounded-2xl border border-border bg-surface p-5 text-left";
  return m.builtin
    ? <div className={cls}>{body}</div>
    : <button type="button" ref={cardRef} onClick={onOpen} aria-label={`${m.name} : ${STATUS[m.status].text(m.connections.length)}. ${m.connections.length ? "Gérer" : "Connecter"}`} className={`${cls} hover:border-control focus-visible:outline-2 focus-visible:outline-accent`}>{body}</button>;
}

/** Catalogue des connecteurs et de leurs connexions (partagé avec l'onboarding). */
export function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Catalog>("/api/connectors").then((c) => { setCatalog(c); setError(""); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  return { catalog, error, reload: load };
}


type RelayStatus = { enabled: boolean; ok: boolean; mode: "test" | "live" | null; error: string | null; url?: string };

/** Carte « Connexion avec Stripe » : consentement explicite, relais optionnel, repli clé limitée (C5, CA32, CA51, CA52). */
function StripeConnect({ onUseKey }: { onUseKey: () => void }) {
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/stripe-oauth/status", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null)).then(setSt).catch(() => setSt({ enabled: false, ok: false, mode: null, error: "unreachable" }));
  }, []);
  if (!st?.enabled) return null;
  const unavailable = !st.ok;
  async function go() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/stripe-oauth/start", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Le service Searchtide Connect ne répond pas. Réessayez, ou utilisez une clé limitée.");
      window.location.href = j.url;
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  const label = st.mode === "test" ? "Continuer vers Stripe (test)" : "Continuer vers Stripe";
  return (
    <Card className="mb-6 p-5">
      <h2 className="text-sm font-medium">Connexion avec Stripe (bêta)</h2>
      {unavailable ? (
        <>
          <p role="alert" className="mt-2 text-sm text-negative">Le service Searchtide Connect est indisponible. Utilisez une clé limitée (aucune donnée ne quitte votre instance).</p>
          <div className="mt-3 flex flex-wrap items-center gap-2"><Button disabled>{label}</Button><button type="button" onClick={onUseKey} className="text-sm text-ink underline">Utiliser une clé limitée</button></div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">Optionnel. Vous serez redirigé vers Stripe ; Searchtide Connect lit votre compte à votre place et ne conserve aucune donnée Stripe.</p>
          <p className="mt-2 text-sm text-ink">Le service <strong>voit les données Stripe demandées</strong> (montants, abonnements) pour répondre à votre instance. Stripe affichera « <strong>lecture et écriture</strong> » : le relais n'émet que des lectures.</p>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
            <span>J'autorise Searchtide Connect, opéré par Nadir DAOUDI, à lire mon compte Stripe. <a href={`${st.url ?? ""}/privacy`} target="_blank" rel="noreferrer noopener" className="underline">Politique de confidentialité</a> · <a href="https://github.com/Nadir-DNA/searchtide/tree/main/relay" target="_blank" rel="noreferrer noopener" className="underline">Code du relais</a>.</span>
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={go} disabled={!consent || busy}>{busy ? "Redirection…" : label}</Button>
            <button type="button" onClick={onUseKey} className="text-sm text-ink underline">Utiliser une clé limitée</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
    </Card>
  );
}

export function ConnectionsView() {
  const { catalog, error, reload: load } = useCatalog();
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const cards = useRef(new Map<string, HTMLButtonElement | null>());
  const opener = useRef<string | null>(null);

  const open = (id: string) => { opener.current = id; setOpenId(id); };
  const close = useCallback(() => setOpenId(null), []);
  // Le focus revient à la carte APRÈS le démontage du tiroir (sinon le piège à focus du tiroir le reprendrait)
  useEffect(() => { if (openId === null && opener.current) return restoreFocus(cards.current.get(opener.current)); }, [openId]);

  const m = catalog?.connectors.find((x) => x.id === openId);
  const real = catalog?.connectors.filter((x) => !x.builtin && (filter === "all" || x.category === filter)) ?? [];
  const builtins = catalog?.connectors.filter((x) => x.builtin) ?? [];

  return (
    <>
      {catalog?.admin && !catalog.demo && <StripeConnect onUseKey={() => open("stripe")} />}
      <header className="pt-4 pb-6 md:min-h-20 md:pt-6">
        <h1 className="text-2xl leading-9 font-light md:text-[30px] md:leading-10">Connexions</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">Branchez vos services ici. Les clés sont chiffrées sur votre instance et ne sont jamais réaffichées.</p>
      </header>

      {error && <p role="alert" className="mb-4 text-sm text-negative">{error}</p>}
      {catalog && !catalog.vault.ok && <p role="alert" className="mb-5 rounded-xl bg-negative-bg px-4 py-3 text-sm text-negative">{catalog.vault.message}</p>}

      {catalog && (
        <>
          <div role="group" aria-label="Filtrer par catégorie" className="mb-5 flex flex-wrap gap-2">
            {FILTERS.map(([v, l]) => (
              <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}
                className={`h-9 rounded-full border px-4 text-sm ${filter === v ? "border-control bg-active text-ink" : "border-border text-muted hover:text-ink"}`}>{l}</button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {real.map((c) => <ConnectorCard key={c.id} m={c} onOpen={() => open(c.id)} cardRef={(el) => { cards.current.set(c.id, el); }} />)}
          </div>
          {!real.length && <p className="text-sm text-muted">Aucun connecteur dans cette catégorie.</p>}

          <h2 className="mt-8 mb-3 text-sm font-medium">Toujours disponibles</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{builtins.map((c) => <ConnectorCard key={c.id} m={c} onOpen={() => {}} />)}</div>

          {catalog.later.length > 0 && (
            <Card className="mt-8">
              <h2 className="text-sm font-medium">Plus tard</h2>
              <ul className="mt-3 flex flex-wrap gap-2">{catalog.later.map((l) => <li key={l} className="rounded-full bg-raised px-3 py-1 text-xs text-muted">{l}</li>)}</ul>
            </Card>
          )}
        </>
      )}

      {m && catalog && <Drawer key={m.id} m={m} catalog={catalog} onClose={close} reload={load} />}
    </>
  );
}
