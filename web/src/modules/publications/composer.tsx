// Publier sur plusieurs comptes (plan D2) : un texte commun, une version par compte, compteur et aperçu par réseau,
// vérification serveur avant l'envoi. Chaque compte reçoit sa propre publication dans la file habituelle.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useData } from "../../App";
import { Button, inputCls } from "../../ui";
import { Field, Sheet, today } from "../shared";

type Account = { id: string; project: string; network: string; label: string; status: string; mode: string };
type Project = { id: string; name: string; crm_key: string | null };
type Result = { group_id: string; items: { id: string; account_id: string; network: string; state: string; error?: string }[] };

const LIMIT: Record<string, number> = { x: 280, instagram: 2200, facebook: 63206, tiktok: 2200, youtube: 5000, linkedin: 3000 };
/** Texte visible avant « voir plus » (ordre de grandeur, variable selon l'appareil). */
const FOLD: Record<string, number> = { linkedin: 210, instagram: 125, facebook: 480 };
const NAME: Record<string, string> = { x: "X", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn" };
const STATE: Record<string, string> = { draft: "Brouillon", scheduled: "Programmée", running: "En cours", published: "Publiée", failed: "Échec", needs_action: "Action requise", to_verify: "À vérifier" };

function Counter({ n, max }: { n: number; max?: number }) {
  if (!max) return <span className="num text-xs text-muted">{n} car.</span>;
  const tone = n > max ? "text-negative" : n > max * 0.9 ? "text-warn" : "text-muted";
  return <span className={`num text-xs font-semibold ${tone}`}>{n} / {max}{n > max ? ` · ${n - max} de trop` : ""}</span>;
}

function Preview({ network, label, text }: { network: string; label: string; text: string }) {
  const fold = FOLD[network];
  const cut = fold && text.length > fold;
  return (
    <div className="rounded-xl border border-border bg-raised p-3 text-sm" aria-label={`Aperçu ${NAME[network] ?? network}`}>
      <div className="mb-2 flex items-center gap-2"><span aria-hidden className="grid size-7 place-items-center rounded-full bg-active text-xs font-semibold">{label.slice(0, 1).toUpperCase()}</span>
        <span className="font-medium">{label}</span><span className="text-xs text-muted">· {NAME[network] ?? network}</span></div>
      <p className="break-words whitespace-pre-wrap">{text ? (cut ? text.slice(0, fold) : text) : <span className="text-muted">Le texte apparaîtra ici.</span>}{cut && <span className="text-muted">… voir plus</span>}</p>
      {cut && <p className="mt-2 text-xs text-muted">Environ {fold} caractères visibles avant « voir plus » : mettez l'essentiel au début.</p>}
    </div>
  );
}

export function MultiComposer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { data: accounts } = useData<Account[]>("/api/pub-accounts");
  const { data: projects } = useData<Project[]>("/api/projects?days=1");
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(today());
  const [base, setBase] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<Record<string, string[]>>({});
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [files, setFiles] = useState<File[]>([]);

  const projectName = (key: string) => projects?.find((p) => p.id === key || p.crm_key === key)?.name ?? key;
  const projectKeys = useMemo(() => [...new Set((accounts ?? []).map((a) => a.project))], [accounts]);
  const shown = (accounts ?? []).filter((a) => !project || a.project === project);
  const selected = shown.filter((a) => picked.includes(a.id));
  const textOf = (id: string) => own[id] ?? base;
  const items = selected.map((a) => ({ account_id: a.id, text: textOf(a.id), visible: visible[a.id] || null }));

  // Vérification serveur (règles exactes de chaque réseau), sans rien créer.
  const media = files.map((f) => ({ mime: f.type || "application/octet-stream", size: f.size }));
  const key = JSON.stringify([title, items, media]);
  useEffect(() => {
    if (!items.length) { setIssues({}); return; }
    const t = setTimeout(() => {
      api<{ account_id: string; issues: string[] }[]>("/api/publications/batch/check", { method: "POST", json: { title, items, media } })
        .then((r) => setIssues(Object.fromEntries(r.map((x) => [x.account_id, x.issues])))).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [key]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  async function send(when: "now" | "at" | null) {
    setBusy(true); setError(""); setResult(null);
    try {
      // Avec des médias : brouillons d'abord, fichiers joints à chacun, puis programmation compte par compte.
      const r = await api<Result>("/api/publications/batch", { method: "POST", json: { title, day: when === "at" && at ? at.slice(0, 10) : day, items, when: files.length ? null : when, at: when === "at" ? new Date(at).toISOString() : undefined } });
      if (files.length) {
        for (const it of r.items) {
          try {
            for (const f of files) {
              const res = await fetch(`/api/publications/${it.id}/media?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: f });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Média refusé");
            }
            if (when) {
              const q = await api<{ state: string }>(`/api/publications/${it.id}/queue`, { method: "POST", json: when === "now" ? { now: true } : { at: new Date(at).toISOString() } });
              it.state = q.state;
            }
          } catch (e) { it.error = (e as Error).message; }
        }
      }
      setResult({ ...r, items: [...r.items] }); onSaved();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const blocking = selected.some((a) => (issues[a.id] ?? []).length > 0);

  return (
    <Sheet title="Publier sur plusieurs comptes" onClose={onClose} wide>
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Titre (pour vous) *"><input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} autoFocus /></Field>
          <Field label="Date"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={inputCls} /></Field>
        </div>
        <Field label="Texte commun"><textarea rows={4} value={base} onChange={(e) => setBase(e.target.value)} className={`${inputCls} h-auto py-2`} placeholder="Écrivez une fois, ajustez ensuite par réseau…" /></Field>

        <Field label="Médias (joints à chaque compte) · JPEG, PNG, WebP, GIF, MP4, MOV, WebM, 25 Mo maximum">
          <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm" onChange={(e) => setFiles([...(e.currentTarget.files ?? [])])} className="block text-sm" />
          {files.length > 0 && <span className="mt-1 block text-xs text-muted">{files.map((f) => `${f.name} (${Math.round(f.size / 1024)} Ko)`).join(" · ")}</span>}
        </Field>

        <fieldset>
          <legend className="label-caps mb-2">Comptes</legend>
          {projectKeys.length > 1 && (
            <select aria-label="Projet" value={project} onChange={(e) => { setProject(e.target.value); setPicked([]); }} className={`${inputCls} mb-3 w-auto`}>
              <option value="">Tous les projets</option>{projectKeys.map((k) => <option key={k} value={k}>{projectName(k)}</option>)}
            </select>
          )}
          {!accounts ? <p className="text-sm text-muted">Chargement…</p> : !shown.length ? <p className="text-sm text-muted">Aucun compte de publication : ajoutez-en dans la section « Comptes de publication ».</p> : (
            <div className="flex flex-wrap gap-2">
              {shown.map((a) => (
                <label key={a.id} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm ${picked.includes(a.id) ? "border-accent bg-raised" : "border-control"}`}>
                  <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} className="size-4 accent-[var(--color-accent)]" />
                  {a.label}<span className="text-xs text-muted">{NAME[a.network] ?? a.network}{projectKeys.length > 1 ? ` · ${projectName(a.project)}` : ""}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {selected.map((a) => {
          const t = textOf(a.id), pb = issues[a.id] ?? [];
          return (
            <section key={a.id} aria-label={`Version ${a.label}`} className="grid gap-4 border-t border-rule pt-4 lg:grid-cols-2">
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2"><span className="font-medium">{a.label} · {NAME[a.network] ?? a.network}</span><Counter n={t.length} max={LIMIT[a.network]} /></div>
                <textarea aria-label={`Texte pour ${a.label}`} rows={5} value={t} onChange={(e) => setOwn({ ...own, [a.id]: e.target.value })} className={`${inputCls} h-auto py-2`} />
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                  {own[a.id] !== undefined && <button type="button" onClick={() => { const n = { ...own }; delete n[a.id]; setOwn(n); }} className="text-muted underline hover:text-ink">Reprendre le texte commun</button>}
                  {a.network === "tiktok" && <label className="flex items-center gap-2 text-muted">Confidentialité
                    <select value={visible[a.id] ?? ""} onChange={(e) => setVisible({ ...visible, [a.id]: e.target.value })} className="rounded-lg border border-control bg-raised px-2 py-1 text-ink">
                      <option value="">— choisir —</option><option value="public">Publique</option><option value="unlisted">Non répertoriée</option><option value="private">Privée</option></select></label>}
                </div>
                {pb.length > 0 && <ul role="alert" className="mt-2 space-y-0.5 text-sm text-negative">{pb.map((x) => <li key={x}>{x}</li>)}</ul>}
              </div>
              <Preview network={a.network} label={a.label} text={t} />
            </section>
          );
        })}

        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        {result && (
          <div role="status" className="rounded-xl border border-border bg-raised p-3 text-sm">
            <p className="mb-1 font-medium">{result.items.length} publication(s) créée(s)</p>
            <ul className="space-y-0.5">{result.items.map((r) => {
              const a = accounts?.find((x) => x.id === r.account_id);
              return <li key={r.id}><span className="font-medium">{a?.label ?? r.network}</span> : <span className={r.error ? "text-negative" : "text-positive"}>{r.error ? `restée en brouillon (${r.error})` : STATE[r.state] ?? r.state}</span></li>;
            })}</ul>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3 border-t border-rule pt-4">
          <Button type="button" variant="secondary" disabled={busy || !title.trim() || !selected.length} onClick={() => send(null)}>Créer les brouillons</Button>
          <Button type="button" disabled={busy || !title.trim() || !selected.length || blocking} onClick={() => send("now")}>Publier maintenant</Button>
          <span className="flex items-end gap-2">
            <Field label="Programmer pour"><input aria-label="Date et heure de programmation" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={inputCls} /></Field>
            <Button type="button" variant="secondary" disabled={busy || !title.trim() || !selected.length || !at || blocking} onClick={() => send("at")}>Programmer</Button>
          </span>
        </div>
        {blocking && <p className="text-xs text-muted">Corrigez les points en rouge pour publier ; les brouillons restent possibles.</p>}
      </div>
    </Sheet>
  );
}
