// Rapport hebdomadaire : aperçu de l'e-mail et envoi manuel.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api";
import { ErrorLine, Header, KpiSkeleton, useData } from "../../App";
import { Button, Card, EmptyBox, Pill, Segmented, Table, fmt, inputCls } from "../../ui";
import { type Contact, type Pub, type Summary, type Go, STAGES, type Stage, stageName, KINDS, PUB_STATUS, NETWORKS, filterCls, eur, today, dateFr, Sheet, Field } from "../shared";

// ── Rapport hebdomadaire : aperçu de l'e-mail et envoi manuel ──
export function ReportView() {
  const { data, error, reload } = useData<{ mail: boolean; week: { from: string; to: string } }>("/api/report");
  const [state, setState] = useState("");
  async function send() {
    setState("Envoi…");
    try { const r = await api<{ to: string }>("/api/report/send", { method: "POST" }); setState(`Envoyé à ${r.to}`); }
    catch (e) { setState((e as Error).message); }
  }
  if (error) return <ErrorLine error={error} retry={reload} />;
  return (
    <>
      <Header title="Rapport de la semaine" sub={data ? `Semaine du ${dateFr(data.week.from, { day: "numeric", month: "long" })} au ${dateFr(data.week.to, { day: "numeric", month: "long" })} · envoyé chaque lundi à 8 h` : undefined}>
        <Button onClick={send} disabled={!data?.mail}>M'envoyer le rapport</Button>
      </Header>
      {data && !data.mail && <div className="mb-4"><EmptyBox>L'envoi par e-mail n'est pas encore branché : renseignez SMTP_URL et REPORT_TO dans le fichier .env de l'instance. L'aperçu ci-dessous fonctionne déjà.</EmptyBox></div>}
      {state && <p role="status" className="mb-4 text-sm">{state}</p>}
      <iframe title="Aperçu du rapport" src="/api/report.html" className="h-[1400px] w-full rounded-2xl border border-border bg-white" />
    </>
  );
}
