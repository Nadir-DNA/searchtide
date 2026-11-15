// Équipe (plan A10) : comptes nominatifs, rôle admin (tous les droits) ou membre (lecture seule). Mot de passe affiché une fois.
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useData } from "./App";
import { Button, Card, copyText, inputCls, useAsk } from "./ui";

type Member = { id: string; email: string; name: string; role: "admin" | "membre"; created_at: number; last_login: number | null };
const ROLE: Record<string, string> = { admin: "Administrateur", membre: "Membre (lecture seule)" };

export function TeamCard() {
  const { ask, dialog } = useAsk();
  const { data, reload } = useData<Member[]>("/api/team");
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState("");
  const act = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); reload(); } catch (e) { setError((e as Error).message); } };
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const form = e.currentTarget; const f = Object.fromEntries(new FormData(form));
    void act(async () => { const m = await api<Member & { password: string }>("/api/team", { method: "POST", json: f }); setSecret({ email: m.email, password: m.password }); form.reset(); });
  };
  const reset = (m: Member) => act(async () => {
    if ((await ask({ title: `Nouveau mot de passe pour ${m.name} ?`, message: "L'ancien cesse de fonctionner et la personne est déconnectée.", confirmLabel: "Réinitialiser" })) === null) return;
    const r = await api<Member & { password: string }>(`/api/team/${m.id}`, { method: "PATCH", json: { resetPassword: true } }); setSecret({ email: r.email, password: r.password });
  });
  const remove = (m: Member) => act(async () => { if ((await ask({ title: `Supprimer le compte de ${m.name} ?`, confirmLabel: "Supprimer" })) === null) return; await api(`/api/team/${m.id}`, { method: "DELETE" }); });
  return (
    <Card title="Équipe">
      {dialog}
      <p className="mb-3 text-sm text-muted">Chaque personne a son compte. Un administrateur a tous les droits ; un membre voit les tableaux de bord, projets, sites et À traiter sans rien modifier. Le mot de passe de l'instance reste celui du propriétaire.</p>
      {error && <p role="alert" className="mb-2 text-sm text-negative">{error}</p>}
      <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
        <input name="email" type="email" required placeholder="adresse@exemple.fr" aria-label="Adresse e-mail" className={inputCls} />
        <input name="name" placeholder="Nom" aria-label="Nom" className={inputCls} />
        <select name="role" aria-label="Rôle" className={inputCls}><option value="membre">{ROLE.membre}</option><option value="admin">{ROLE.admin}</option></select>
        <Button>Créer le compte</Button>
      </form>
      {secret && (
        <div role="status" className="mt-3 rounded-xl border border-border bg-raised p-3 text-sm">
          <p className="font-medium">Mot de passe de {secret.email} (affiché une seule fois)</p>
          <p className="mt-1 font-mono break-all">{secret.password}</p>
          <p className="mt-1 text-xs text-muted">Transmettez-le par un canal sûr. Connexion : écran d'accueil → « Compte d'équipe ».</p>
          <Button className="mt-2" variant="secondary" onClick={async () => { await copyText(secret.password); setSecret(null); }}>Copier et masquer</Button>
        </div>
      )}
      <ul className="mt-4 divide-y divide-rule">{(data ?? []).map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
          <span className="min-w-0 flex-1"><span className="font-medium">{m.name}</span> <span className="text-muted">· {m.email}</span></span>
          <select aria-label={`Rôle de ${m.name}`} value={m.role} onChange={(e) => act(() => api(`/api/team/${m.id}`, { method: "PATCH", json: { role: e.target.value } }))} className="rounded-lg border border-control bg-raised px-2 py-1">
            <option value="membre">{ROLE.membre}</option><option value="admin">{ROLE.admin}</option></select>
          <span className="text-xs text-muted">{m.last_login ? `vu le ${new Date(m.last_login).toLocaleDateString("fr-FR")}` : "jamais connecté"}</span>
          <button type="button" onClick={() => reset(m)} className="text-xs underline">Nouveau mot de passe</button>
          <button type="button" onClick={() => remove(m)} className="text-xs text-negative hover:underline">Supprimer</button>
        </li>))}</ul>
    </Card>
  );
}
