// Fiche de publication unique : écrire, choisir le moment, suivre. Remplace l'ancienne fiche et le composeur « Plusieurs comptes ».
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useData } from "../../App";
import { Button, Card, EmptyBox, Segmented, copyText, fmt, inputCls, useAsk } from "../../ui";
import { ATTEMPT_LABEL, Field, NET_LIMIT, NET_NAME, NETWORKS, PUB_STATE, Sheet, dateFr, keysOf, projectKey, today, type ProjectRef, type Pub } from "../shared";
import { splitThread } from "../../thread";
import { VisualsCard } from "./visuals";

type Account = { id: string; project: string; network: string; label: string; status: string; mode: string; web_url: string | null; publications: number; connection_id?: string | null; browser_fallback?: number; target?: string | null };
type Created = { id: string; account_id: string | null };
type Result = { group_id: string; items: { id: string; account_id: string; network: string; state: string; error?: string }[] };
type When = "now" | "at" | "draft" | "repeat";

/** Texte visible avant « voir plus » (ordre de grandeur, variable selon l'appareil). */
const FOLD: Record<string, number> = { linkedin: 210, instagram: 125, facebook: 480 };
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const REPLIES = new Set(["x", "linkedin", "facebook", "instagram", "reddit"]);
const THREADS = new Set(["x"]);
const TAGS: Record<string, { max?: number; advised: number }> = { instagram: { max: 30, advised: 5 }, x: { advised: 2 }, linkedin: { advised: 3 }, tiktok: { advised: 5 }, facebook: { advised: 3 }, youtube: { max: 60, advised: 3 }, pinterest: { advised: 5 } };
const countTags = (t: string) => (t.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;

/** Prochaine occurrence du jour et de l'heure, au format attendu par un champ datetime-local. */
function nextSlot(weekday: number, hour: number) {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(hour);
  let add = (weekday - d.getDay() + 7) % 7; if (add === 0 && d.getTime() <= Date.now()) add = 7;
  d.setDate(d.getDate() + add);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}
const toLocal = (ts: number | null | undefined) => {
  if (!ts) return "";
  const d = new Date(ts); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function Counter({ n, max }: { n: number; max?: number }) {
  if (!max) return <span className="num text-xs text-muted">{n} car.</span>;
  const tone = n > max ? "text-negative" : n > max * 0.9 ? "text-warn" : "text-muted";
  return <span className={`num text-xs font-semibold ${tone}`}>{n} / {max}{n > max ? ` · ${n - max} de trop` : ""}</span>;
}

function Preview({ network, label, text }: { network: string; label: string; text: string }) {
  const fold = FOLD[network];
  const cut = fold && text.length > fold;
  return (
    <div className="rounded-xl border border-border bg-raised p-3 text-sm" aria-label={`Aperçu ${NET_NAME[network] ?? network}`}>
      <div className="mb-2 flex items-center gap-2"><span aria-hidden className="grid size-7 place-items-center rounded-full bg-active text-xs font-semibold">{label.slice(0, 1).toUpperCase()}</span>
        <span className="font-medium">{label}</span><span className="text-xs text-muted">· {NET_NAME[network] ?? network}</span></div>
      <p className="break-words whitespace-pre-wrap">{text ? (cut ? text.slice(0, fold) : text) : <span className="text-muted">Le texte apparaîtra ici.</span>}{cut && <span className="text-muted">… voir plus</span>}</p>
      {cut && <p className="mt-2 text-xs text-muted">Environ {fold} caractères visibles avant « voir plus » : mettez l'essentiel au début.</p>}
    </div>
  );
}

type EditorPub = Partial<Pub> & { first_comment?: string | null; thread?: string | null };

/** Une seule fiche : comptes, texte par compte, médias, moment, puis suivi. */
export function PubEditor({ pub, projects, defaultProject, onClose, onSaved }: {
  pub?: EditorPub | null; projects: ProjectRef[]; defaultProject?: string; onClose: () => void; onSaved: () => void;
}) {
  const initial = pub ?? {};
  const { ask, dialog } = useAsk();
  const { data: accounts } = useData<Account[]>("/api/pub-accounts");
  const { data: slots } = useData<{ enough: boolean; measured: number; slots: { weekday: number; hour: number; engagement: number }[] }>("/api/publications/best-slots");
  const editing = !!initial.id;

  const [snapshot, setSnapshot] = useState<EditorPub>(initial);
  const [created, setCreated] = useState<Created[]>(initial.id ? [{ id: initial.id, account_id: initial.account_id ?? null }] : []);
  const [title, setTitle] = useState(initial.title ?? "");
  const [project, setProject] = useState(initial.project ?? defaultProject ?? "");
  const [picked, setPicked] = useState<string[]>(initial.account_id ? [initial.account_id] : []);
  const [manual, setManual] = useState(!initial.account_id && !!initial.network);
  const [network, setNetwork] = useState(initial.network ?? "");
  const [text, setText] = useState(initial.text ?? "");
  const [own, setOwn] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, string>>(initial.visible && initial.account_id ? { [initial.account_id]: initial.visible } : {});
  const [comment, setComment] = useState<Record<string, string>>(initial.first_comment && initial.account_id ? { [initial.account_id]: initial.first_comment } : {});
  const [thread, setThread] = useState<Record<string, string[]>>(() => {
    if (!initial.account_id || !initial.thread) return {};
    try { return { [initial.account_id]: JSON.parse(initial.thread) }; } catch { return {}; }
  });
  const [tags, setTags] = useState<Record<string, Record<string, string>>>({});
  const [day, setDay] = useState(initial.day ?? today());
  const [when, setWhen] = useState<When>(initial.state === "scheduled" ? "at" : "draft");
  const [at, setAt] = useState(toLocal(initial.scheduled_at));
  const [repeat, setRepeat] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [media, setMedia] = useState<{ id: string; name: string; mime: string; size: number }[]>([]);
  const [attempts, setAttempts] = useState<{ ts: number; state: string; detail: string | null; evidence_url: string | null }[]>([]);
  const [issues, setIssues] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [visuals, setVisuals] = useState<string[] | null>(null);

  const state = snapshot.state ?? "draft";
  const locked = state === "scheduled";
  const isManual = manual && !picked.length;

  const inProject = (a: Account) => {
    if (!project) return true;
    const p = projects.find((x) => keysOf(x).includes(project));
    return p ? keysOf(p).includes(a.project) : a.project === project;
  };
  const mine = (accounts ?? []).filter((a) => inProject(a) || picked.includes(a.id));
  const selected = picked.map((id) => mine.find((a) => a.id === id)).filter(Boolean) as Account[];
  const byNetwork = useMemo(() => {
    const m: Record<string, Account[]> = {};
    for (const a of mine) (m[a.network] ??= []).push(a);
    return m;
  }, [mine, accounts]);
  const textOf = (id: string) => own[id] ?? text;
  const limit = selected.length ? Math.min(...selected.map((a) => NET_LIMIT[a.network] ?? 100000)) : undefined;

  const items = selected.map((a) => ({ account_id: a.id, text: textOf(a.id), visible: visible[a.id] || null,
    ...(comment[a.id]?.trim() ? { first_comment: comment[a.id] } : {}), ...(thread[a.id]?.length ? { thread: thread[a.id] } : {}) }));
  const checkKey = JSON.stringify([title, items, files.map((f) => [f.name, f.size, f.type])]);

  // Vérification serveur (règles exactes de chaque réseau), sans rien créer.
  useEffect(() => {
    if (!selected.length) { setIssues({}); return; }
    const t = setTimeout(() => {
      api<{ account_id: string; issues: string[] }[]>("/api/publications/batch/check", { method: "POST", json: { title, items, media: files.map((f) => ({ mime: f.type || "application/octet-stream", size: f.size })) } })
        .then((r) => setIssues(Object.fromEntries(r.map((x) => [x.account_id, x.issues])))).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);

  useEffect(() => {
    if (!snapshot.id) return;
    void api<any[]>(`/api/publications/${snapshot.id}/attempts`).then(setAttempts).catch(() => {});
    void api<any[]>(`/api/publications/${snapshot.id}/media`).then(setMedia).catch(() => {});
  }, [snapshot.id, state]);

  // Hashtags enregistrés par projet et par réseau.
  const projectsPicked = [...new Set(selected.map((a) => a.project))].join(",");
  useEffect(() => {
    for (const p of projectsPicked.split(",").filter(Boolean)) if (!tags[p]) api<Record<string, string>>(`/api/hashtags?project=${encodeURIComponent(p)}`).then((t) => setTags((x) => ({ ...x, [p]: t }))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsPicked]);

  const toggle = (id: string) => { setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); setManual(false); };
  const saveTags = async (a: Account) => {
    const found = (textOf(a.id).match(/#[\p{L}\p{N}_]+/gu) ?? []).join(" ");
    const t = await api<Record<string, string>>("/api/hashtags", { method: "PUT", json: { project: a.project, network: a.network, tags: found } }).catch(() => null);
    if (t) setTags({ ...tags, [a.project]: t });
  };
  const addTags = (a: Account) => { const t = tags[a.project]?.[a.network]; if (t) setOwn({ ...own, [a.id]: `${textOf(a.id).trimEnd()}\n\n${t}` }); };
  const cutThread = (a: Account) => { const parts = splitThread(textOf(a.id), NET_LIMIT[a.network]); setOwn({ ...own, [a.id]: parts[0] ?? "" }); setThread({ ...thread, [a.id]: parts.slice(1) }); };

  async function upload(id: string, file: File) {
    const r = await fetch(`/api/publications/${id}/media?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? "Média refusé");
  }

  /** Crée les brouillons (un par compte) sans rien programmer. Sert aussi au premier média et au visuel. */
  async function createDrafts(): Promise<Created[]> {
    if (created.length) return created;
    if (!title.trim()) throw new Error("Titre requis");
    if (!picked.length && !manual) throw new Error("Cochez au moins un compte");
    if (!picked.length) {
      if (!network) throw new Error("Choisissez le réseau de la publication");
      const p = await api<Pub>("/api/publications", { method: "POST", json: { title, day, project: project || null, network, text, status: "idea" } });
      const list = [{ id: p.id, account_id: null }];
      setCreated(list); setSnapshot(p); onSaved(); return list;
    }
    const r = await api<Result>("/api/publications/batch", { method: "POST", json: { title, day, items, when: null } });
    const list = r.items.map((i) => ({ id: i.id, account_id: i.account_id }));
    setCreated(list); onSaved(); return list;
  }

  async function addFiles(list: File[]) {
    if (!list.length) return;
    setError(""); setBusy(true);
    try {
      const targets = await createDrafts();
      for (const f of list) for (const c of targets) await upload(c.id, f);
      if (targets.length === 1) void api<any[]>(`/api/publications/${targets[0].id}/media`).then(setMedia).catch(() => {});
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  async function dropMedia(mediaId: string) {
    if (!snapshot.id) return;
    await api(`/api/publications/${snapshot.id}/media/${mediaId}`, { method: "DELETE" });
    setMedia(await api(`/api/publications/${snapshot.id}/media`));
  }
  async function openVisuals() {
    setError(""); setBusy(true);
    try { setVisuals((await createDrafts()).map((c) => c.id)); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function save() {
    setError(""); setMsg(""); setBusy(true);
    try {
      if ((when === "at" || when === "repeat") && !at) throw new Error("Choisissez la date et l'heure");
      const dayValue = when === "at" || when === "repeat" ? (at ? at.slice(0, 10) : day) : day;
      const status = state === "published" ? "published" : when === "draft" ? "idea" : "scheduled";
      let list = created;
      if (!list.length) list = await createDrafts();
      else {
        for (const c of list) {
          const acc = selected.find((a) => a.id === c.account_id) ?? accounts?.find((a) => a.id === c.account_id);
          const saved = await api<Pub>(`/api/publications/${c.id}`, { method: "PATCH", json: {
            title, day: dayValue, project: project || null, network: (acc?.network ?? network) || null,
            text: acc ? textOf(acc.id) : text, account_id: acc?.id ?? null, visible: acc ? visible[acc.id] || null : null, status,
          } });
          if (list.length === 1) setSnapshot(saved);
        }
      }
      for (const c of list) for (const f of files) await upload(c.id, f);
      if (files.length) setFiles([]);
      if (when !== "draft") {
        for (const c of list) {
          const acc = selected.find((a) => a.id === c.account_id) ?? accounts?.find((a) => a.id === c.account_id);
          const p = await api<Pub>(`/api/publications/${c.id}/queue`, { method: "POST", json: {
            now: when === "now", at: when === "now" ? undefined : new Date(at).toISOString(),
            text: acc ? textOf(acc.id) : text, visible: acc ? visible[acc.id] || undefined : undefined, account_id: acc?.id,
          } });
          if (list.length === 1) setSnapshot(p);
        }
        if (when === "repeat" && Number(repeat) > 0) for (const c of list) await api(`/api/publications/${c.id}/repeat`, { method: "POST", json: { days: Number(repeat) } }).catch(() => {});
      }
      if (list.length === 1) void api<Pub>(`/api/publications/${list[0].id}`).then(setSnapshot).catch(() => {});
      onSaved();
      if (when === "draft") setMsg("Brouillon enregistré.");
      else onClose();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  /** Publication sans compte : le brouillon puis « Marquer publiée » en une fois. */
  async function markPublished() {
    setBusy(true); setError("");
    try {
      const list = await createDrafts();
      const u = await ask({ title: "Marquer comme publiée ?", message: "Vous avez vérifié que la publication existe. Collez son adresse comme preuve.", confirmLabel: "Marquer publiée", inputLabel: "Adresse de la publication" });
      if (u === null) return;
      const p = await api<Pub>(`/api/publications/${list[0].id}/resolve`, { method: "POST", json: { outcome: "published", url: u || undefined } });
      setSnapshot(p); onSaved(); onClose();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function cancel() {
    if (!snapshot.id) return;
    setError("");
    try { const p = await api<Pub>(`/api/publications/${snapshot.id}/cancel`, { method: "POST" }); setSnapshot(p); onSaved(); }
    catch (e) { setError((e as Error).message); }
  }
  async function retry() {
    if (!snapshot.id) return;
    setBusy(true); setError("");
    try { const p = await api<Pub>(`/api/publications/${snapshot.id}/retry`, { method: "POST" }); setSnapshot(p); onSaved(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!snapshot.id) return;
    if ((await ask({ title: "Supprimer cette publication ?", message: "Le suivi de ses liens cesse.", confirmLabel: "Supprimer" })) === null) return;
    await api(`/api/publications/${snapshot.id}`, { method: "DELETE" }); onSaved(); onClose();
  }
  async function resolve(outcome: "published" | "draft") {
    if (!snapshot.id) return;
    setBusy(true); setError("");
    try {
      let url: string | undefined;
      if (outcome === "published") { const u = await ask({ title: "Marquer comme publiée ?", message: "Vous avez vérifié sur le réseau que la publication existe. Collez son adresse comme preuve.", confirmLabel: "Marquer publiée", inputLabel: "Adresse de la publication" }); if (u === null) return; url = u || undefined; }
      const p = await api<Pub>(`/api/publications/${snapshot.id}/resolve`, { method: "POST", json: { outcome, url } });
      setSnapshot(p); onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function saveTracking() {
    if (!snapshot.id) return;
    setError(""); setMsg("");
    try {
      const p = await api<Pub>(`/api/publications/${snapshot.id}`, { method: "PATCH", json: { url: snapshot.url ?? null, notes: snapshot.notes ?? null } });
      setSnapshot(p); setMsg("Suivi enregistré."); onSaved();
    } catch (e) { setError((e as Error).message); }
  }

  const blocking = selected.some((a) => (issues[a.id] ?? []).length > 0);
  const why = !title.trim() ? "Donnez un titre à la publication."
    : !picked.length && !manual ? "Cochez au moins un compte."
    : isManual && !network ? "Choisissez le réseau."
    : locked ? "Publication programmée : annulez-la pour la modifier."
    : blocking ? "Corrigez les points en rouge."
    : "";
  const whenOptions = isManual ? ([["draft", "Brouillon"]] as const) : ([["draft", "Brouillon"], ["at", "Date et heure"], ["now", "Maintenant"], ["repeat", "Répéter"]] as const);
  const mainLabel = isManual ? "Enregistrer le brouillon" : when === "now" ? "Publier maintenant" : when === "at" ? "Programmer" : when === "repeat" ? "Programmer et répéter" : "Enregistrer le brouillon";

  return (
    <Sheet title={editing ? "Publication" : "Nouvelle publication"} onClose={onClose} wide>
      {dialog}
      <div className="space-y-6">
        <fieldset disabled={locked} className="space-y-6">
          <section aria-labelledby="pub-ecrire" className="space-y-4">
            <h3 id="pub-ecrire" className="text-sm font-semibold">Écrire</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Titre (pour vous) *"><input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} autoFocus /></Field>
              <Field label="Projet"><select value={project} onChange={(e) => { setProject(e.target.value); setPicked([]); setManual(false); }} className={inputCls}>
                <option value="">— aucun —</option>
                {projects.map((p) => <option key={p.id} value={projectKey(p)}>{p.name}</option>)}
                {project && !projects.some((p) => keysOf(p).includes(project)) && <option value={project}>{project}</option>}
              </select></Field>
            </div>

            <fieldset>
              <legend className="label-caps mb-2">Comptes</legend>
              {!accounts ? <p className="text-sm text-muted">Chargement…</p> : !mine.length ? <p className="text-sm text-muted">Aucun compte pour ce projet : connectez-en un dans Comptes, ou publiez sans compte.</p> : (
                <div className="space-y-3">
                  {Object.entries(byNetwork).map(([n, list]) => (
                    <div key={n}>
                      <p className="mb-1 text-xs text-muted">{NET_NAME[n] ?? n}</p>
                      <div className="flex flex-wrap gap-2">
                        {list.map((a) => (
                          <label key={a.id} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm ${picked.includes(a.id) ? "border-accent bg-raised" : "border-control"}`}>
                            <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} className="size-4 accent-[var(--color-accent)]" />
                            {a.label}{a.status !== "connected" && <span className="text-xs text-negative">À reconnecter</span>}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => { setManual(!manual); setPicked([]); }} className="mt-3 text-xs text-muted underline hover:text-ink">
                {isManual ? "Publier sur un compte" : "Publier sans compte (blog, newsletter, saisie manuelle)"}
              </button>
              {isManual && <div className="mt-2 max-w-xs"><Field label="Réseau ou support"><select value={network} onChange={(e) => setNetwork(e.target.value)} className={inputCls}>
                <option value="">— choisir —</option>{NETWORKS.map((n) => <option key={n} value={n}>{NET_NAME[n] ?? n}</option>)}
              </select></Field></div>}
            </fieldset>

            {selected.map((a) => {
              const t = textOf(a.id), pb = issues[a.id] ?? [];
              return (
                <section key={a.id} aria-label={`Version ${a.label}`} className="grid gap-4 border-t border-rule pt-4 lg:grid-cols-2">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2"><span className="font-medium">{a.label} · {NET_NAME[a.network] ?? a.network}</span><Counter n={t.length} max={NET_LIMIT[a.network]} /></div>
                    <textarea aria-label={`Texte pour ${a.label}`} rows={5} value={t} onChange={(e) => { if (selected.length === 1) setText(e.target.value); else setOwn({ ...own, [a.id]: e.target.value }); }} className={`${inputCls} h-auto py-2`} />
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                      {own[a.id] !== undefined && selected.length > 1 && <button type="button" onClick={() => { const n = { ...own }; delete n[a.id]; setOwn(n); }} className="text-muted underline hover:text-ink">Reprendre le texte commun</button>}
                      {THREADS.has(a.network) && t.length > (NET_LIMIT[a.network] ?? Infinity) && <button type="button" onClick={() => cutThread(a)} className="font-semibold text-accent hover:underline">Découper en fil</button>}
                      {tags[a.project]?.[a.network] && !t.includes(tags[a.project][a.network]) && <button type="button" onClick={() => addTags(a)} className="text-muted underline hover:text-ink">Ajouter {tags[a.project][a.network]}</button>}
                      {countTags(t) > 0 && <button type="button" onClick={() => saveTags(a)} className="text-muted underline hover:text-ink">Retenir ces hashtags pour {NET_NAME[a.network] ?? a.network}</button>}
                      {countTags(t) > 0 && TAGS[a.network] && <span className={countTags(t) > (TAGS[a.network].max ?? Infinity) ? "font-semibold text-negative" : countTags(t) > TAGS[a.network].advised ? "text-warn" : "text-muted"}>
                        {countTags(t)} hashtag{countTags(t) > 1 ? "s" : ""} · {TAGS[a.network].advised} conseillé{TAGS[a.network].advised > 1 ? "s" : ""}{TAGS[a.network].max ? `, ${TAGS[a.network].max} au plus` : ""}</span>}
                      {(a.network === "tiktok" || a.network === "youtube") && <label className="flex items-center gap-2 text-muted">Confidentialité
                        <select value={visible[a.id] ?? ""} onChange={(e) => setVisible({ ...visible, [a.id]: e.target.value })} className="rounded-lg border border-control bg-raised px-2 py-1 text-ink">
                          <option value="">— choisir —</option><option value="public">Publique</option><option value="unlisted">Non répertoriée</option><option value="private">Privée</option></select></label>}
                    </div>
                    {(thread[a.id] ?? []).map((part, i) => (
                      <div key={i} className="mt-3 border-l-2 border-rule pl-3">
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs"><span className="text-muted">Suite du fil · partie {i + 2}</span><Counter n={part.length} max={NET_LIMIT[a.network]} /></div>
                        <textarea aria-label={`Partie ${i + 2} du fil pour ${a.label}`} rows={3} value={part} onChange={(e) => setThread({ ...thread, [a.id]: (thread[a.id] ?? []).map((x, j) => j === i ? e.target.value : x) })} className={`${inputCls} h-auto py-2`} />
                        <button type="button" onClick={() => setThread({ ...thread, [a.id]: (thread[a.id] ?? []).filter((_, j) => j !== i) })} className="mt-1 text-xs text-negative hover:underline">Retirer cette partie</button>
                      </div>))}
                    {THREADS.has(a.network) && <button type="button" onClick={() => setThread({ ...thread, [a.id]: [...(thread[a.id] ?? []), ""] })} className="mt-2 text-xs text-muted underline hover:text-ink">+ Ajouter une partie au fil</button>}
                    {REPLIES.has(a.network) && (
                      <label className="mt-3 block text-xs text-muted">Premier commentaire (facultatif, publié juste après)
                        <textarea aria-label={`Premier commentaire pour ${a.label}`} rows={2} value={comment[a.id] ?? ""} onChange={(e) => setComment({ ...comment, [a.id]: e.target.value })} className={`${inputCls} mt-1 h-auto py-2 text-sm text-ink`} placeholder="Lien, hashtags, question pour lancer la discussion…" />
                      </label>)}
                    {pb.length > 0 && <ul role="alert" className="mt-2 space-y-0.5 text-sm text-negative">{pb.map((x) => <li key={x}>{x}</li>)}</ul>}
                  </div>
                  <Preview network={a.network} label={a.label} text={t} />
                </section>
              );
            })}

            <div className="rounded-xl border border-border bg-raised p-3">
              <p className="text-sm">Médias <span className="text-xs text-muted">JPEG, PNG, WebP, GIF, MP4, MOV, WebM · 25 Mo maximum · joints à chaque compte</span></p>
              <input type="file" multiple aria-label="Ajouter un média" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm" onChange={(e) => { void addFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ""; }} className="mt-2 block text-sm" />
              {(files.length > 0 || media.length > 0) && (
                <ul className="mt-2 space-y-1 text-sm">
                  {files.map((f, i) => <li key={`f${i}`} className="text-muted">{f.name} · {Math.round(f.size / 1024)} Ko</li>)}
                  {media.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <a href={`/api/media/${m.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink underline">{m.name}</a>
                      <span className="text-xs text-muted">{m.mime} · {(m.size / 1024).toFixed(0)} Ko</span>
                      <button type="button" onClick={() => dropMedia(m.id)} className="text-xs text-negative hover:underline">Retirer</button>
                    </li>
                  ))}
                </ul>
              )}
              <Button type="button" variant="secondary" className="mt-3" disabled={busy || (!picked.length && !manual)} onClick={openVisuals}>Créer un visuel</Button>
              {!picked.length && !manual && <p className="mt-1 text-xs text-muted">Choisissez un compte ou un réseau pour créer un visuel.</p>}
            </div>
          </section>

          <section aria-labelledby="pub-quand" className="space-y-3">
            <h3 id="pub-quand" className="text-sm font-semibold">Quand</h3>
            <Segmented label="Moment de publication" value={when} onChange={(v) => { setWhen(v as When); if (v === "now" && isManual) setWhen("draft"); }} options={whenOptions} />
            {isManual && <p className="text-xs text-muted">Sans compte, la publication ne peut pas partir toute seule : enregistrez le brouillon puis « Marquer publiée » dans Suivi.</p>}
            {(when === "at" || when === "repeat") && (
              <div className="flex flex-wrap items-end gap-4">
                <Field label="Date et heure"><input aria-label="Date et heure" type="datetime-local" value={at} onChange={(e) => { setAt(e.target.value); if (e.target.value) setDay(e.target.value.slice(0, 10)); }} className={inputCls} /></Field>
                {when === "repeat" && <Field label="Répéter tous les… jours"><input type="number" min={1} max={365} value={repeat} onChange={(e) => setRepeat(e.target.value)} placeholder="ex. 30" className={`${inputCls} w-32`} /></Field>}
              </div>
            )}
            {when !== "draft" && slots?.enough && (
              <div className="text-sm"><span className="mb-1.5 block text-muted">Vos meilleurs créneaux</span>
                <span className="flex flex-wrap gap-2">{slots.slots.map((s) => (
                  <button key={`${s.weekday}-${s.hour}`} type="button" onClick={() => { setAt(nextSlot(s.weekday, s.hour)); setWhen("at"); }} className="inline-flex min-h-9 items-center rounded-full border border-control px-3 hover:bg-raised">
                    {DAYS[s.weekday]} {s.hour} h <span className="ml-1.5 text-xs text-muted">~{s.engagement} interactions</span></button>))}</span></div>
            )}
            {when !== "draft" && slots && !slots.enough && <p className="text-xs text-muted">Créneaux conseillés à partir de 5 publications mesurées ({slots.measured} pour l'instant).</p>}
          </section>
        </fieldset>

        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        {msg && <p role="status" className="text-sm text-positive">{msg}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-4">
          <Button type="button" disabled={busy || locked || !!why} onClick={save}>{busy ? "Enregistrement…" : mainLabel}</Button>
          {isManual && <Button type="button" variant="secondary" disabled={busy || !!why} onClick={markPublished}>Marquer publiée</Button>}
          {locked && <button type="button" onClick={cancel} className="text-sm text-negative hover:underline">Annuler la programmation</button>}
          {!why && !locked ? null : <p className="w-full text-xs text-muted">{why}</p>}
        </div>

        {snapshot.id && (
          <details className="rounded-2xl border border-border bg-surface p-4">
            <summary className="cursor-pointer text-sm font-medium">Suivi</summary>
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className={PUB_STATE[state]?.[1] ?? "text-muted"}>● {PUB_STATE[state]?.[0] ?? state}</span>
                {snapshot.evidence_url && <a href={snapshot.evidence_url} target="_blank" rel="noreferrer" className="text-ink underline">Voir la preuve</a>}
                {snapshot.visits != null && <span className="text-xs text-muted">{fmt(snapshot.visits)} visite{snapshot.visits > 1 ? "s" : ""} amenée{snapshot.visits > 1 ? "s" : ""}</span>}
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
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Publiée ailleurs ? Collez son adresse"><input type="url" value={snapshot.url ?? ""} onChange={(e) => setSnapshot({ ...snapshot, url: e.target.value })} className={inputCls} /></Field>
                <Field label="Notes"><textarea rows={2} value={snapshot.notes ?? ""} onChange={(e) => setSnapshot({ ...snapshot, notes: e.target.value })} className={`${inputCls} h-auto py-2`} /></Field>
              </div>
              <Button type="button" variant="secondary" onClick={saveTracking}>Enregistrer le suivi</Button>
              {snapshot.campaign && <TrackingLink pub={{ ...snapshot, project, network }} />}
              {attempts.length > 0 && (
                <div><p className="text-sm">Tentatives</p>
                  <ul className="mt-1 space-y-1 text-xs text-muted">{attempts.map((a, i) => <li key={i}><span className="num">{new Date(a.ts).toLocaleString("fr-FR")}</span> · {ATTEMPT_LABEL[a.state] ?? "Autre"} {a.detail ? `· ${a.detail}` : ""}</li>)}</ul>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {["scheduled", "draft", "failed", "needs_action", "missed", "cancelled"].includes(state) && <button type="button" onClick={cancel} className="text-sm text-negative hover:underline">Annuler</button>}
                {["failed", "needs_action", "missed"].includes(state) && <button type="button" onClick={retry} className="text-sm text-ink underline">Réessayer</button>}
                <button type="button" onClick={remove} className="ml-auto text-sm text-negative hover:underline">Supprimer</button>
              </div>
              {selected.some((a) => a.network === "x") && <FollowupsBox id={snapshot.id} state={state} pub={snapshot} />}
            </div>
          </details>
        )}
      </div>

      {visuals && (
        <Sheet title="Créer un visuel" onClose={() => setVisuals(null)} wide>
          <VisualsCard project={projects.find((p) => keysOf(p).includes(project))} publicationIds={visuals} onAttached={() => { onSaved(); setMsg("Visuel joint à la publication."); }} />
        </Sheet>
      )}
    </Sheet>
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

type Followup = { idx: number; kind: string; text: string; state: string; url: string | null; detail: string | null };
const FSTATE: Record<string, [string, string]> = { pending: ["En attente", "text-muted"], running: ["En cours", "text-muted"], sent: ["Envoyée", "text-positive"], failed: ["Échec", "text-negative"], to_verify: ["À vérifier", "text-warn"] };

/** Premier commentaire et fil : suivis partie par partie après la publication. */
function FollowupsBox({ id, state, pub }: { id: string; state: string; pub: EditorPub }) {
  const { data, reload } = useData<Followup[]>(`/api/publications/${id}/followups`);
  const [msg, setMsg] = useState("");
  const act = async (idx: number, body: Record<string, string> = {}) => { await api(`/api/publications/${id}/followups/${idx}`, { method: "POST", json: body }).catch((e) => setMsg((e as Error).message)); reload(); };
  if (!data?.length && !["scheduled", "running", "published", "to_verify"].includes(state)) return null;
  return (
    <div className="rounded-xl border border-border bg-raised p-3 text-sm">
      <p>Suites <span className="text-xs text-muted">premier commentaire et fil, envoyés après la publication</span></p>
      <ul className="mt-2 space-y-1">{(data ?? []).map((f) => (
        <li key={f.idx} className="flex flex-wrap items-baseline gap-2">
          <span className={FSTATE[f.state]?.[1]}>● {FSTATE[f.state]?.[0] ?? f.state}</span>
          <span className="min-w-0 flex-1 truncate">{f.kind === "thread" ? `Partie ${f.idx + 1}` : "Premier commentaire"} · {f.text}</span>
          {f.url && <a href={f.url} target="_blank" rel="noreferrer" className="text-xs underline">voir</a>}
          {f.state === "failed" && <button type="button" onClick={() => act(f.idx)} className="text-xs underline">Réessayer</button>}
          {f.state === "to_verify" && <><button type="button" onClick={() => act(f.idx, { outcome: "sent" })} className="text-xs underline">Elle est en ligne</button><button type="button" onClick={() => act(f.idx, { outcome: "pending" })} className="text-xs underline">Renvoyer</button></>}
          {f.detail && <span className="w-full text-xs text-muted">{f.detail}</span>}
        </li>))}</ul>
      {!data?.length && <p className="mt-1 text-xs text-muted">Aucune suite prévue.</p>}
      {msg && <p role="status" className="mt-2 text-xs">{msg}</p>}
    </div>
  );
}
