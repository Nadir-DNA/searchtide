// Module Rendez-vous : RDV réservés, types de RDV (lien public), flux iCal et jours bloqués.
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../../App";
import { Button, Card, EmptyBox, Pill, Segmented, copyText, inputCls, useAsk } from "../../ui";
import { Field, Sheet, type Go } from "../shared";

type Type = { id: string; slug: string; name: string; description: string; project_id: string | null; duration_min: number; location_kind: string; location_value: string;
  min_notice_h: number; buffer_min: number; horizon_days: number; step_min: number; tz: string; rules: Record<string, [string, string][]>; active: boolean; url: string };
type Booking = { id: string; name: string; email: string; phone: string; message: string; start_ts: number; end_ts: number; status: string; type_name: string; location_kind: string;
  location_value: string; tz: string; project_id: string | null; project_name: string | null; project_color: string | null };
type Overview = { mail: boolean; calendar: string | null; meet_auto: boolean; feed_url: string; types: Type[]; blocks: { day: string; note: string }[] };
type Proj = { id: string; name: string };

const KINDS = [["meet", "Google Meet"], ["teams", "Microsoft Teams"], ["zoom", "Zoom"], ["phone", "Téléphone"], ["other", "Autre"]] as const;
const DAYS = [["1", "Lundi"], ["2", "Mardi"], ["3", "Mercredi"], ["4", "Jeudi"], ["5", "Vendredi"], ["6", "Samedi"], ["0", "Dimanche"]] as const;
const when = (b: Booking) => new Intl.DateTimeFormat("fr-FR", { timeZone: b.tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(b.start_ts);
const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41);

// « 09:00-12:00, 14:00-18:00 » ⇄ [["09:00","12:00"],["14:00","18:00"]]
const toText = (w: [string, string][] = []) => w.map(([a, b]) => `${a}-${b}`).join(", ");
const toWindows = (t: string): [string, string][] => t.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(x);
  if (!m) throw new Error(`Horaire illisible : « ${x} » (attendu 09:00-12:00)`);
  const p = (h: string, mi: string) => `${h.padStart(2, "0")}:${mi}`;
  return [p(m[1], m[2]), p(m[3], m[4])];
});

export function RdvView({ q, go }: { q: Record<string, string>; go: Go }) {
  const [when_, setWhen] = useState<"upcoming" | "past">("upcoming");
  const project = q.project ?? "";
  const { data, error, reload } = useData<Overview>("/api/rdv");
  const list = useData<Booking[]>(`/api/rdv/bookings?when=${when_}${project ? `&project=${project}` : ""}`);
  const { data: projects } = useData<Proj[]>("/api/projects");
  const [edit, setEdit] = useState<Partial<Type> | null>(null);
  const { ask, dialog } = useAsk();
  const [copied, setCopied] = useState("");
  const copy = async (k: string, text: string) => { if (await copyText(text)) { setCopied(k); setTimeout(() => setCopied(""), 1500); } };
  const [gmsg, setGmsg] = useState<{ text: string; ok: boolean } | null>(null);
  // retour de l'autorisation Google : le serveur redirige ici avec ?gcal=ok ou un message
  useEffect(() => {
    const p = new URLSearchParams(location.search), g = p.get("gcal");
    if (!g) return;
    setGmsg({ text: g === "ok" ? "Google Agenda connecté." : g, ok: g === "ok" });
    p.delete("gcal"); history.replaceState(null, "", location.pathname + (p.size ? "?" + p : ""));
    reload();
  }, []);
  const projName = (id: string | null) => projects?.find((p) => p.id === id)?.name;
  const cancel = async (b: Booking) => {
    if ((await ask({ title: `Annuler le RDV avec ${b.name} ?`, message: "Le client et vous recevez l'annulation par e-mail.", confirmLabel: "Annuler le RDV" })) === null) return;
    await api(`/api/rdv/bookings/${b.id}/cancel`, { method: "POST" }).catch((e) => alert((e as Error).message));
    list.reload();
  };
  return (
    <>
      <Header title="Rendez-vous" sub="Liens de réservation publics, invitations par e-mail, flux iCal">
        <select aria-label="Projet" value={project} onChange={(e) => go({ project: e.target.value || undefined })} className={`${inputCls} w-44`}>
          <option value="">Tous les projets</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Button onClick={() => setEdit({ duration_min: 30, location_kind: "meet", project_id: project || null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, min_notice_h: 4, buffer_min: 0, horizon_days: 60, step_min: 30, active: true,
          rules: Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, [["09:00", "12:00"], ["14:00", "18:00"]]])) as Type["rules"] })}>Nouveau type de RDV</Button>
      </Header>
      {error ? <ErrorLine error={error} retry={reload} /> : !data ? <KpiSkeleton /> : (
        <div className="space-y-6">
          {gmsg && <p role="status" className={`text-sm ${gmsg.ok ? "text-positive" : "text-negative"}`}>{gmsg.text}</p>}
          {!data.mail && <EmptyBox>Aucun e-mail (SMTP) connecté : les réservations marchent, mais personne ne reçoit d'invitation. Ajoutez E-mail (SMTP) dans Connexions.</EmptyBox>}
          <Card title="Types de RDV">
            {data.types.length === 0 ? <EmptyBox>Aucun type de RDV. Créez-en un : vous obtenez un lien à envoyer à vos clients.</EmptyBox> : (
              <ul className="divide-y divide-rule">
                {data.types.filter((t) => !project || t.project_id === project).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{t.name} {!t.active && <Pill>Désactivé</Pill>}</div>
                      <div className="truncate text-muted">{[projName(t.project_id), `${t.duration_min} min`, KINDS.find((k) => k[0] === t.location_kind)?.[1]].filter(Boolean).join(" · ")}</div>
                    </div>
                    <Button variant="secondary" onClick={() => copy(t.id, t.url)}>{copied === t.id ? "Copié" : "Copier le lien"}</Button>
                    <a className="text-ink underline" href={t.url} target="_blank" rel="noreferrer">Ouvrir</a>
                    <Button variant="secondary" onClick={() => setEdit(t)}>Modifier</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Rendez-vous" action={<Segmented label="Période" value={when_} onChange={setWhen} options={[["upcoming", "À venir"], ["past", "Passés"]]} />}>
            {list.error ? <ErrorLine error={list.error} retry={list.reload} /> : !list.data ? <KpiSkeleton /> : list.data.length === 0 ? <EmptyBox>{when_ === "upcoming" ? "Aucun rendez-vous à venir." : "Aucun rendez-vous passé."}</EmptyBox> : (
              <ul className="divide-y divide-rule">
                {list.data.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                    <span className="num w-40 shrink-0">{when(b)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate"><span className="font-medium">{b.name}</span> · {b.type_name}</div>
                      <div className="truncate text-muted">{[b.project_name, b.email, b.phone, b.location_value].filter(Boolean).join(" · ")}</div>
                      {b.message && <div className="truncate text-muted">« {b.message} »</div>}
                    </div>
                    {b.status === "cancelled" ? <Pill tone="negative">Annulé</Pill> : when_ === "upcoming" && <Button variant="secondary" onClick={() => cancel(b)}>Annuler</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Agenda">
            <p className="mb-3 text-sm">{data.calendar ? <>Agenda connecté : <strong>{data.calendar}</strong>. Ses événements bloquent les créneaux et chaque RDV s'y inscrit.</>
              : <span className="text-muted">Aucun agenda connecté : seuls les RDV déjà pris bloquent des créneaux.</span>}</p>
            {!data.calendar && <GoogleConnect />}
            <p className="text-sm text-muted">Abonnez votre agenda (Google, Outlook, Apple, Nextcloud) à ce flux : tous les rendez-vous y apparaissent. Chaque invitation par e-mail s'ajoute aussi directement.</p>
            <div className="mt-3 flex gap-2"><input readOnly value={data.feed_url} className={`${inputCls} font-mono`} onFocus={(e) => e.target.select()} aria-label="Adresse du flux iCal" />
              <Button variant="secondary" onClick={() => copy("feed", data.feed_url)}>{copied === "feed" ? "Copié" : "Copier"}</Button></div>
            <Blocks blocks={data.blocks} reload={reload} />
          </Card>
        </div>
      )}
      {edit && projects && <TypeSheet type={edit} projects={projects} meetAuto={!!data?.meet_auto} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {dialog}
    </>
  );
}

function Blocks({ blocks, reload }: { blocks: Overview["blocks"]; reload: () => void }) {
  const [day, setDay] = useState("");
  const add = async () => { if (!day) return; await api("/api/rdv/blocks", { method: "POST", json: { day } }).catch((e) => alert((e as Error).message)); setDay(""); reload(); };
  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium">Jours bloqués (congés, jours fériés)</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {blocks.map((b) => <button key={b.day} className="rounded-full border border-control bg-raised px-3 py-1 text-sm" aria-label={`Débloquer le ${b.day}`}
          onClick={async () => { await api(`/api/rdv/blocks/${b.day}`, { method: "DELETE" }); reload(); }}>{b.day} ✕</button>)}
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={`${inputCls} w-44`} aria-label="Jour à bloquer" />
        <Button variant="secondary" onClick={add}>Bloquer</Button>
      </div>
    </div>
  );
}

function TypeSheet({ type, projects, meetAuto, onClose, onSaved }: { type: Partial<Type>; projects: Proj[]; meetAuto: boolean; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(type);
  const [hours, setHours] = useState(() => Object.fromEntries(DAYS.map(([d]) => [d, toText(type.rules?.[d])])));
  const [error, setError] = useState("");
  const [slugTouched, setSlugTouched] = useState(!!type.id);
  const { ask, dialog } = useAsk();
  const set = (k: keyof Type, val: unknown) => setV((p) => ({ ...p, [k]: val }));
  const num = (k: keyof Type) => ({ type: "number" as const, value: (v[k] as number) ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value)), className: inputCls });
  async function save(e: FormEvent) {
    e.preventDefault(); setError("");
    try {
      const rules = Object.fromEntries(DAYS.map(([d]) => [d, toWindows(hours[d] ?? "")]).filter(([, w]) => (w as unknown[]).length));
      const body = { ...v, rules, project_id: v.project_id || null };
      await (v.id ? api(`/api/rdv/types/${v.id}`, { method: "PATCH", json: body }) : api("/api/rdv/types", { method: "POST", json: body }));
      onSaved();
    } catch (err) { setError((err as Error).message); }
  }
  async function remove() {
    if ((await ask({ title: "Supprimer ce type de RDV ?", message: "Son lien cesse de fonctionner et l'historique de ses rendez-vous est supprimé.", confirmLabel: "Supprimer" })) === null) return;
    try { await api(`/api/rdv/types/${v.id}`, { method: "DELETE" }); onSaved(); } catch (err) { setError((err as Error).message); }
  }
  return (
    <Sheet title={v.id ? "Modifier le type de RDV" : "Nouveau type de RDV"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Nom"><input required className={inputCls} value={v.name ?? ""} onChange={(e) => { set("name", e.target.value); if (!slugTouched) set("slug", slugify(e.target.value)); }} placeholder="Appel découverte" /></Field>
        <Field label="Lien public : /rdv/…"><input required className={`${inputCls} font-mono`} value={v.slug ?? ""} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value); }} /></Field>
        <Field label="Projet"><select className={inputCls} value={v.project_id ?? ""} onChange={(e) => set("project_id", e.target.value || null)}><option value="">Aucun</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Description (affichée au client)"><textarea className={`${inputCls} h-20 py-2`} value={v.description ?? ""} onChange={(e) => set("description", e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Durée (min)"><input {...num("duration_min")} min={5} max={480} required /></Field>
          <Field label="Pas entre créneaux (min)"><input {...num("step_min")} min={5} max={240} /></Field>
          <Field label="Préavis minimum (h)"><input {...num("min_notice_h")} min={0} /></Field>
          <Field label="Tampon entre RDV (min)"><input {...num("buffer_min")} min={0} max={120} /></Field>
          <Field label="Réservable jusqu'à (jours)"><input {...num("horizon_days")} min={1} max={180} /></Field>
          <Field label="Fuseau horaire"><input className={inputCls} value={v.tz ?? ""} onChange={(e) => set("tz", e.target.value)} /></Field>
        </div>
        <Field label="Lieu"><select className={inputCls} value={v.location_kind} onChange={(e) => set("location_kind", e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label={v.location_kind === "phone" ? "Numéro de téléphone" : v.location_kind === "other" ? "Lieu ou consigne" : v.location_kind === "meet" && meetAuto ? "Lien Meet (laissez vide : créé automatiquement par Google Agenda)" : "Lien de la réunion (https://…)"}>
          <input className={inputCls} value={v.location_value ?? ""} onChange={(e) => set("location_value", e.target.value)} /></Field>
        <fieldset className="space-y-2"><legend className="text-sm text-muted">Horaires (ex. 09:00-12:00, 14:00-18:00 ; vide = fermé)</legend>
          {DAYS.map(([d, l]) => <div key={d} className="flex items-center gap-3"><span className="w-24 text-sm">{l}</span>
            <input aria-label={l} className={inputCls} value={hours[d] ?? ""} onChange={(e) => setHours((h) => ({ ...h, [d]: e.target.value }))} /></div>)}
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v.active} onChange={(e) => set("active", e.target.checked)} /> Lien actif</label>
        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        <div className="flex justify-between"><Button>Enregistrer</Button>{v.id && <Button type="button" variant="secondary" onClick={remove}>Supprimer</Button>}</div>
      </form>
      {dialog}
    </Sheet>
  );
}

/** Connexion à Google Agenda par le relais Searchtide Connect : consentement explicite, repli CalDAV. */
function GoogleConnect() {
  const [st, setSt] = useState<{ enabled: boolean; ok: boolean; google: boolean; url?: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api<NonNullable<typeof st>>("/api/google-oauth/status").then(setSt).catch(() => setSt({ enabled: false, ok: false, google: false })); }, []);
  async function go() {
    setBusy(true); setError("");
    try { window.location.href = (await api<{ url: string }>("/api/google-oauth/start", { method: "POST" })).url; }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  const caldav = <p className="mt-2 text-sm text-muted">Autres agendas (iCloud, Nextcloud, Fastmail…) : connectez « Agenda (CalDAV) » dans Connexions.</p>;
  if (!st) return null;
  if (!st.enabled || !st.ok || !st.google) return <>
    <p className="mt-2 text-sm text-muted">Google Agenda se connecte via le service Searchtide Connect : définissez <code className="font-mono">RELAY_URL</code> sur votre instance {st.enabled && !st.google ? "(ce relais ne propose pas encore Google Agenda)" : ""}.</p>{caldav}</>;
  return (
    <div className="mt-2">
      <p className="text-sm">Vos événements bloqueront les créneaux, et chaque RDV s'inscrira dans votre agenda avec un <strong>lien Google Meet créé automatiquement</strong>.</p>
      <p className="mt-2 text-sm text-muted">Le service Searchtide Connect <strong>ne lit pas votre agenda</strong> et ne conserve aucun jeton Google : votre instance parle directement à Google. Google vous demandera deux autorisations : voir vos occupations, et créer/supprimer les rendez-vous.</p>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
        <span>J'autorise Searchtide Connect, opéré par Nadir DAOUDI, à relier mon Google Agenda à cette instance. <a href={`${st.url ?? ""}/privacy`} target="_blank" rel="noreferrer noopener" className="underline">Politique de confidentialité</a> · <a href="https://github.com/Nadir-DNA/searchtide/tree/main/relay" target="_blank" rel="noreferrer noopener" className="underline">Code du relais</a>.</span>
      </label>
      <div className="mt-3"><Button onClick={go} disabled={!consent || busy}>{busy ? "Redirection…" : "Connecter Google Agenda"}</Button></div>
      {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
      {caldav}
    </div>
  );
}
