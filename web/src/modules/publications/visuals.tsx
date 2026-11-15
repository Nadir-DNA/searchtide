// Visuels et vidéos (plan D11) : carrousel aux couleurs du projet, rendu en images JPEG, vidéo diaporama MP4 si ffmpeg est là.
import { useState } from "react";
import { api } from "../../api";
import { useData } from "../../App";
import { Button, Card, inputCls } from "../../ui";
import { Field } from "../shared";

type Slide = { title: string; text?: string };
type Visual = { id: string; format: string; slides: Slide[]; images: number; video: boolean; created_at: number };
type Info = { formats: Record<string, { label: string }>; ffmpeg: boolean; ai: boolean; visuals: Visual[] };
type Pub = { id: string; title: string; state?: string | null };

/** « Titre | texte » par ligne, ou blocs séparés par une ligne vide (première ligne = titre). */
const parse = (raw: string): Slide[] => raw.split(/\n\s*\n|\n(?=[^\n]*\|)/).map((b) => b.trim()).filter(Boolean).map((b) => {
  if (b.includes("|")) { const [title, ...rest] = b.split("|"); return { title: title.trim(), text: rest.join("|").trim() || undefined }; }
  const [title, ...rest] = b.split("\n"); return { title: title.trim(), text: rest.join("\n").trim() || undefined };
});

export function VisualsCard() {
  const { data, reload } = useData<Info>("/api/visuals");
  const { data: pubs } = useData<Pub[]>(`/api/publications?from=${new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)}`);
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("");
  const [format, setFormat] = useState("carre");
  const [mode, setMode] = useState("clair");
  const [color, setColor] = useState("#ff7a52");
  const [footer, setFooter] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const slides = parse(text);
  const act = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } setBusy(""); };
  const make = (video: boolean) => act(video ? "video" : "images", async () => { await api("/api/visuals", { method: "POST", json: { slides, format, mode, color, footer, video } }); reload(); });
  const write = () => act("ai", async () => { const s = await api<Slide[]>("/api/visuals/slides", { method: "POST", json: { topic, count: 5 } }); setText(s.map((x) => `${x.title}${x.text ? `\n${x.text}` : ""}`).join("\n\n")); });
  const drafts = (pubs ?? []).filter((p) => !["scheduled", "running", "processing", "published"].includes(String(p.state ?? "draft")));
  return (
    <Card title="Visuels et vidéos">
      <p className="mb-3 text-sm text-muted">Écrivez un carrousel : Searchtide le met en page à vos couleurs et le transforme en images, puis en vidéo diaporama pour TikTok, Reels ou Shorts. Joignez ensuite les fichiers à un brouillon.</p>
      {msg && <p role="status" className="mb-3 text-sm">{msg}</p>}
      {!data ? <p className="text-sm text-muted">Chargement…</p> : (
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-3">
            {data.ai && <div className="flex gap-2"><input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Sujet, ex. 5 erreurs à éviter pour un devis toiture" aria-label="Sujet du carrousel" className={inputCls} />
              <Button type="button" variant="secondary" disabled={!topic.trim() || !!busy} onClick={write}>{busy === "ai" ? "Rédaction…" : "Rédiger (IA)"}</Button></div>}
            <Field label={`Diapositives (${slides.length}/10) · un bloc par diapositive : titre, puis texte court`}>
              <textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} h-auto py-2`} placeholder={"5 erreurs qui coûtent cher\nÀ éviter avant de signer un devis\n\nNe pas comparer\nDemandez au moins trois devis détaillés."} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Format"><select value={format} onChange={(e) => setFormat(e.target.value)} className={inputCls}>{Object.entries(data.formats).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}</select></Field>
              <Field label="Style"><select value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}><option value="clair">Fond clair</option><option value="couleur">Fond couleur</option></select></Field>
              <Field label="Couleur"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-full rounded border border-control bg-raised" /></Field>
              <Field label="Pied de page"><input value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="@votrecompte" className={inputCls} /></Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!slides.length || slides.length > 10 || !!busy} onClick={() => make(false)}>{busy === "images" ? "Rendu…" : "Créer les images"}</Button>
              <Button type="button" variant="secondary" disabled={!slides.length || slides.length > 10 || !!busy || !data.ffmpeg} onClick={() => make(true)}>{busy === "video" ? "Montage…" : "Images + vidéo"}</Button>
              {!data.ffmpeg && <span className="self-center text-xs text-muted">Vidéo : ffmpeg absent de l'instance.</span>}
            </div>
          </div>
          <ul className="space-y-4">{data.visuals.map((v) => (
            <li key={v.id} className="rounded-xl border border-border p-3">
              <div className="no-scrollbar flex gap-2 overflow-x-auto">{Array.from({ length: v.images }, (_, i) => (
                <a key={i} href={`/api/visuals/${v.id}/${i + 1}.jpg`} target="_blank" rel="noreferrer" className="shrink-0"><img src={`/api/visuals/${v.id}/${i + 1}.jpg`} alt={`Diapositive ${i + 1} : ${v.slides[i]?.title ?? ""}`} className="h-28 rounded-lg border border-border" loading="lazy" /></a>))}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">{v.images} image{v.images > 1 ? "s" : ""}{v.video ? " · vidéo" : ""}</span>
                {v.video && <a href={`/api/visuals/${v.id}/video.mp4`} target="_blank" rel="noreferrer" className="underline">Voir la vidéo</a>}
                <select aria-label="Joindre à un brouillon" defaultValue="" onChange={(e) => { const id = e.target.value; e.target.value = ""; if (id) void act("attach", async () => { const r = await api<{ attached: number }>(`/api/visuals/${v.id}/attach`, { method: "POST", json: { publication_id: id, what: v.video ? "video" : "images" } }); setMsg(`${r.attached} fichier(s) joint(s) au brouillon.`); }); }} className="ml-auto rounded-lg border border-control bg-raised px-2 py-1">
                  <option value="">Joindre à un brouillon…</option>{drafts.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
                <button type="button" onClick={() => act("del", async () => { await api(`/api/visuals/${v.id}`, { method: "DELETE" }); reload(); })} className="text-xs text-negative hover:underline">Supprimer</button>
              </div>
            </li>))}</ul>
        </div>
      )}
    </Card>
  );
}
