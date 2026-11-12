// L1 : écran des approbations. L'administrateur voit la demande en texte (secrets masqués), approuve ou rejette,
// et suit les états en attente / approuvée / consommée / rejetée / expirée. Aucun HTML n'est interprété.
import { useState } from "react";
import { api } from "./api";
import { Header, useData } from "./App";
import { Button, Card, EmptyBox, Pill, Skeleton } from "./ui";

type Approval = {
  id: string;
  agent_name: string;
  project_id: string;
  project_name: string;
  action: string;
  target_id: string | null;
  target_label: string | null;
  removed?: string[];
  payload: string | null;
  before: string | null;
  after: string | null;
  expires_at: number;
  state: "pending" | "approved" | "consumed" | "rejected" | "expired";
  used: number;
  created_at: number;
};
type SecurityEvent = { ts: number; kind: string; detail: string | null };

const ACTIONS: Record<string, string> = {
  indicator_source: "Modifier un indicateur",
  indicator_delete: "Supprimer un indicateur",
  project_delete: "Supprimer un projet",
};
const STATES: Record<Approval["state"], { label: string; tone: "positive" | "negative" | "neutral" }> = {
  pending: { label: "En attente", tone: "neutral" },
  approved: { label: "Approuvée", tone: "positive" },
  consumed: { label: "Consommée", tone: "positive" },
  rejected: { label: "Rejetée", tone: "negative" },
  expired: { label: "Expirée", tone: "negative" },
};
const when = (t: number) => new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
const pretty = (text: string | null): string | null => {
  if (text == null || text === "null") return null;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

export function ApprovalsView() {
  const { data: approvals, error, reload } = useData<Approval[]>("/api/approvals");
  const { data: events, reload: reloadEvents } = useData<SecurityEvent[]>("/api/security/events?limit=100");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");

  async function decide(a: Approval, decision: "approve" | "reject") {
    setBusy(a.id); setNotice(""); setProblem("");
    try {
      await api(`/api/approvals/${a.id}/${decision}`, { method: "POST" });
      setNotice(decision === "approve" ? "Demande approuvée : l'agent peut l'exécuter une fois." : "Demande rejetée.");
      reload(); reloadEvents();
    } catch (e) {
      setProblem((e as Error).message);
      reload();
    } finally { setBusy(null); }
  }

  const pending = (approvals ?? []).filter((a) => a.state === "pending");

  return (
    <>
      <Header title="Approbations" sub="Une clé d'agent peut proposer une modification ; vous seul l'approuvez. Chaque approbation est à usage unique et expire après 24 h.">
        <Button variant="secondary" onClick={() => { reload(); reloadEvents(); }}>Actualiser</Button>
      </Header>
      <div className="space-y-4">
        {notice && <p role="status" className="rounded-xl border border-border bg-raised px-3 py-2 text-sm">{notice}</p>}
        {problem && <p role="alert" className="rounded-xl border border-border bg-raised px-3 py-2 text-sm text-negative">Échec : {problem}</p>}
        <Card title={`Demandes${pending.length ? ` · ${pending.length} en attente` : ""}`}>
          {!approvals && !error && <Skeleton className="h-24 w-full" />}
          {error && <EmptyBox>Impossible de charger les demandes : {error}. <button onClick={reload} className="underline">Réessayer</button></EmptyBox>}
          {approvals && !approvals.length && <EmptyBox>Aucune demande pour l'instant.</EmptyBox>}
          <ul className="space-y-3">
            {(approvals ?? []).map((a) => <ApprovalCard key={a.id} a={a} busy={busy === a.id} onDecide={decide} />)}
          </ul>
        </Card>

        <Card title="Journal de sécurité" action={<Button variant="secondary" onClick={reloadEvents}>Actualiser</Button>}>
          {events && !events.length && <EmptyBox>Aucun événement de sécurité.</EmptyBox>}
          {!events && <Skeleton className="h-16 w-full" />}
          <ul className="divide-y divide-rule text-sm">
            {(events ?? []).map((e, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="num w-40 shrink-0 text-muted">{when(e.ts)}</span>
                <span className="font-mono text-xs">{e.kind}</span>
                {e.detail && <span className="text-muted">{e.detail}</span>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function ApprovalCard({ a, busy, onDecide }: { a: Approval; busy: boolean; onDecide: (a: Approval, d: "approve" | "reject") => void }) {
  const state = STATES[a.state] ?? STATES.pending;
  const payload = pretty(a.payload);
  const before = pretty(a.before);
  const after = pretty(a.after);
  return (
    <li data-testid={`approval-${a.id}`} className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Pill tone={state.tone}>{state.label}</Pill>
        <span className="font-medium">{ACTIONS[a.action] ?? a.action}</span>
        <span className="text-sm text-muted">· {a.agent_name} · {a.project_name}</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
          Créée le {when(a.created_at)} · expire le {when(a.expires_at)}
        </span>
      </div>
      <p className="mt-1 text-sm">
        Cible : {a.target_label ? <strong>{a.target_label}</strong> : <span className="text-muted">aucune</span>}
        {a.target_id && <span className="ml-2 font-mono text-xs text-muted">{a.target_id}</span>}
      </p>
      {!!a.removed?.length && <p className="mt-1 text-sm text-negative">Champs retirés : <span className="font-mono">{a.removed.join(", ")}</span></p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-muted">Voir la charge utile{a.before ? " et l'avant/après" : ""}</summary>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {payload && <Block label="Charge utile" text={payload} />}
          {before && <Block label="Avant" text={before} />}
          {after && <Block label="Après" text={after} />}
        </div>
      </details>
      {a.state === "pending" && (
        <div className="mt-3 flex items-center gap-2">
          <Button disabled={busy} onClick={() => onDecide(a, "approve")}>{busy ? "…" : "Approuver"}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => onDecide(a, "reject")}>Rejeter</Button>
          <span className="text-xs text-muted">Une approbation ne vaut que pour cette charge exacte, une seule fois.</span>
        </div>
      )}
    </li>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-raised px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
}
