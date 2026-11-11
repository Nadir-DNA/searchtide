// J3 : écran « Connexions navigateur », réservé à l'administrateur. Flux d'écran SSE + relais d'entrées.
// Aucune furtivité : le navigateur reste celui de Chromium ; les vérifications sont faites par la personne.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { Header, useData } from "./App";
import { Button, Card, inputCls } from "./ui";

type Status = { open: boolean; viewers: number };

export function BrowserView({ q }: { q: Record<string, string> }) {
  const { data: status, reload } = useData<Status>("/api/browser/status");
  const [ticket, setTicket] = useState(q.ticket ?? "");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [frame, setFrame] = useState("");
  const [typing, setTyping] = useState("");
  const [busy, setBusy] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const events = useRef<number[]>([]);

  useEffect(() => {
    if (!ticket) return;
    const es = new EventSource(`/api/browser/live/stream?ticket=${encodeURIComponent(ticket)}`);
    es.addEventListener("frame", (e) => setFrame(`data:image/jpeg;base64,${(e as MessageEvent).data}`));
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      if (data) setError(String(data));
    });
    es.addEventListener("closed", () => { setFrame(""); reload(); });
    return () => es.close();
    // Ne pas dépendre de `reload` (nouvelle fonction à chaque rendu) : le ticket est à usage unique.
  }, [ticket]);

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api<{ ticket: string }>("/api/browser/live", { method: "POST", json: { url } });
      setTicket(r.ticket); reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function close() {
    try { await api("/api/browser/live/close", { method: "POST", json: {} }); } catch { /* déjà fermée */ }
    setTicket(""); setFrame(""); reload();
  }
  async function send(event: Record<string, unknown>) {
    if (!ticket) return;
    const now = Date.now();
    events.current = events.current.filter((t) => now - t < 1000);
    if (events.current.length >= 60) return;                 // même plafond que le serveur
    events.current.push(now);
    try { await api("/api/browser/live/input", { method: "POST", json: { ticket, event } }); }
    catch (err) { setError((err as Error).message); }
  }
  const at = (e: React.MouseEvent<HTMLImageElement>) => {
    const el = img.current!;
    const r = el.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) / r.width * el.naturalWidth), y: Math.round((e.clientY - r.top) / r.height * el.naturalHeight) };
  };

  return (
    <>
      <Header title="Connexions navigateur" sub="Connexion manuelle sur un site, dans Searchtide. Vous tapez vous-même vos identifiants et vos codes : Searchtide ne les stocke pas et ne résout aucune vérification.">
        {ticket && <Button variant="secondary" onClick={close}>Fermer la vue</Button>}
      </Header>
      <div className="space-y-4">
        <Card title="Avertissement">
          <p className="text-sm text-muted">
            Les conditions d'utilisation de certains réseaux restreignent l'automatisation ; le risque pour le compte est assumé par son titulaire.
            Searchtide ne contourne ni CAPTCHA, ni double authentification, ni refus d'accès, et ne masque pas le navigateur.
            Un site peut donc refuser la connexion : c'est un résultat attendu, pas une panne.
          </p>
        </Card>
        {!ticket && (
          <Card title="Ouvrir une page">
            <form onSubmit={start} className="flex flex-wrap items-end gap-3">
              <label className="min-w-64 flex-1 text-sm">Adresse
                <input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://www.exemple.com/connexion" className={`${inputCls} mt-1`} />
              </label>
              <Button disabled={busy || !!status?.open}>{busy ? "Ouverture…" : "Ouvrir"}</Button>
            </form>
            {status?.open && !ticket && <p className="mt-3 text-sm text-muted">Une vue est déjà ouverte dans une autre fenêtre. Fermez-la depuis cette fenêtre, ou attendez 10 minutes d'inactivité.</p>}
            {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
          </Card>
        )}
        {ticket && (
          <Card title="Vue en direct" action={<span className="text-xs text-muted">Une seule vue · fermeture après 10 min d'inactivité</span>}>
            {!frame && !error && <p className="text-sm text-muted">Connexion à l'image…</p>}
            {error && <p role="alert" className="text-sm text-negative">{error}</p>}
            {frame && (
              <img ref={img} src={frame} alt="Écran du navigateur distant" className="w-full cursor-crosshair rounded-xl border border-border"
                onClick={(e) => send({ type: "click", ...at(e) })} onMouseMove={(e) => send({ type: "move", ...at(e) })}
                onWheel={(e) => send({ type: "wheel", deltaY: Math.round(e.deltaY), ...at(e) })} />
            )}
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="min-w-64 flex-1 text-sm">Saisie clavier (transmise à la page, jamais conservée)
                <input value={typing} onChange={(e) => setTyping(e.target.value)}
                  onKeyDown={(e) => { if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) { void send({ type: "key", key: e.key }); if (e.key === "Enter") e.preventDefault(); } }}
                  onKeyUp={() => { if (typing) { void send({ type: "text", text: typing }); setTyping(""); } }}
                  className={`${inputCls} mt-1`} autoComplete="off" />
              </label>
              <Button variant="secondary" onClick={() => { if (typing) { void send({ type: "text", text: typing }); setTyping(""); } }}>Envoyer le texte</Button>
            </div>
            <p className="mt-2 text-xs text-muted">La session n'est pas enregistrée dans cette version : à la fermeture, un contexte neuf repart sans cookie.</p>
          </Card>
        )}
      </div>
    </>
  );
}
