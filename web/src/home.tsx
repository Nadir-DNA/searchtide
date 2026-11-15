// Accueil : le mur et les pages personnalisées en onglets, plus les sites qui n'appartiennent à aucun projet.
import { WallView } from "./wall";
import { DashboardView, type Dashboards } from "./dashboard";
import { Button, Card, EmptyBox, Segmented, Table } from "./ui";
import type { Site } from "./api";

type Go = (n: Record<string, string | undefined>) => void;
type Project = { id: string; name: string; sites: string[] };

export function HomeView({ dash, days, go, demo, sites, projects, selected, onNewPage }: {
  dash: Dashboards | null; days: number; go: Go; demo: boolean; sites: Site[]; projects: Project[];
  selected?: string; onNewPage?: () => void;
}) {
  const pages = dash?.dashboards ?? [];
  const tab = selected === "mur" || selected === undefined ? "mur" : pages.some((p) => p.id === selected) ? selected : (selected === "" ? pages[0]?.id ?? "mur" : "mur");
  const current = pages.find((p) => p.id === tab);
  const owned = new Set(projects.flatMap((p) => p.sites));
  const loose = sites.filter((s) => !owned.has(s.domain));
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 pt-4 md:pt-6">
        <div className="min-w-0 overflow-x-auto">
          <Segmented label="Pages de l'accueil" value={tab} onChange={(v) => v === "mur" ? go({ view: undefined, id: undefined, tab: undefined }) : go({ view: "page", id: v, tab: undefined })}
            options={[["mur", "Mur"], ...pages.map((p) => [p.id, p.name] as [string, string])] as const} />
        </div>
        <div className="flex flex-wrap gap-2">
          {!demo && onNewPage && <Button variant="secondary" onClick={onNewPage}>+ Nouvelle page</Button>}
          {!demo && <Button variant="secondary" onClick={() => go({ view: "add", site: undefined, id: undefined })}>Ajouter un site</Button>}
        </div>
      </div>

      {current ? (dash ? <DashboardView key={current.id} dash={current} catalog={dash.catalog} sizes={dash.sizes} days={days} go={go} onChanged={() => {}} /> : null) : <WallView days={days} go={go} />}

      <div className="mt-6">
        <Card title="Sites sans projet">
          {!loose.length ? <EmptyBox>Tous les sites sont rattachés à un projet.</EmptyBox> : (
            <Table rows={loose} empty="" onRow={(s) => go({ site: s.domain, view: undefined, id: undefined })} cols={[
              { label: "Site", render: (s) => s.domain },
              { label: "Visites aujourd'hui", num: true, render: (s) => s.today ?? "—" },
            ]} />
          )}
          <p className="mt-3 text-xs text-muted">Un site sans projet reste consultable ; rattachez-le dans Projet → Réglages pour retrouver ses chiffres avec les autres.</p>
        </Card>
      </div>
    </>
  );
}
