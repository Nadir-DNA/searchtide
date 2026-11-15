// Rapports : portefeuille, rapport de la semaine et rapports clients, au même endroit.
import { Header, useData } from "./App";
import { PortfolioView } from "./portefeuille";
import { ReportView } from "./modules/notifications/ReportView";
import { Card, EmptyBox, Segmented, Table } from "./ui";

type Go = (n: Record<string, string | undefined>) => void;
type Project = { id: string; name: string };
const TABS = [["portefeuille", "Portefeuille"], ["semaine", "Rapport de la semaine"], ["clients", "Rapports clients"]] as const;

export function ReportsView({ tab = "portefeuille", days, go }: { tab?: string; days: number; go: Go }) {
  const current = TABS.some(([k]) => k === tab) ? tab : "portefeuille";
  return (
    <>
      <Header title="Rapports" sub="Le portefeuille, la semaine et ce que voient vos clients." />
      <div className="mb-5 -mt-1 overflow-x-auto">
        <Segmented label="Sections des rapports" value={current} onChange={(v) => go({ tab: v === "portefeuille" ? undefined : v })} options={TABS} />
      </div>
      {current === "semaine" ? <ReportView /> : current === "clients" ? <ClientReports /> : <PortfolioView days={days} go={go} />}
    </>
  );
}

/** Consultation en lecture : le réglage du rapport reste dans Projet → Réglages. */
function ClientReports() {
  const { data: projects } = useData<Project[]>("/api/projects?days=1");
  if (!projects) return null;
  return (
    <Card title="Rapports clients">
      {!projects.length ? <EmptyBox>Aucun projet.</EmptyBox> : (
        <Table rows={projects} empty="Aucun projet." cols={[
          { label: "Projet", render: (p) => p.name },
          { label: "", num: true, render: (p) => <a href={`/api/projects/${p.id}/report-preview`} target="_blank" rel="noreferrer" className="text-sm text-ink underline">Aperçu</a> },
        ]} />
      )}
      <p className="mt-3 text-xs text-muted">La présentation, le logo et les liens de partage se règlent dans Projet → Réglages.</p>
    </Card>
  );
}
