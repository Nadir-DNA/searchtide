// Écran Modules (spec §5.1) : ce que chaque module apporte, son état, sa connexion (tiroir existant) et les projets concernés.
import { useEffect, useState } from "react";
import { api } from "../api";
import { Header, useData } from "../App";
import { Drawer, useCatalog } from "../connections";
import { useModules, type ModuleInfo } from ".";
import { Button, Card, Pill } from "../ui";

type Go = (n: Record<string, string | undefined>) => void;
const STATUS: Record<ModuleInfo["status"], [string, "positive" | "negative" | "neutral"]> = { actif: ["Actif", "positive"], "a-reconnecter": ["À reconnecter", "negative"], inactif: ["Inactif", "neutral"] };

export function ModulesView({ open, go }: { open?: string; go: Go }) {
  const { modules, reload } = useModules();
  const { catalog, reload: reloadCatalog } = useCatalog();
  const { data: projects } = useData<{ id: string; name: string }[]>("/api/projects?days=1");
  const [drawer, setDrawer] = useState<string | null>(null);
  const [error, setError] = useState("");
  const admin = !!catalog?.admin;
  const manifest = (id: string) => catalog?.connectors.find((c) => c.id === id);

  // Arrivée depuis « Activer X » : on montre la carte et, si une connexion manque, on ouvre son tiroir
  useEffect(() => {
    if (!open || !catalog || !modules.length) return;
    document.getElementById(`module-${open}`)?.scrollIntoView({ block: "center" });
    const missing = modules.find((m) => m.id === open)?.connectors.find((c) => !c.connected);
    if (missing && admin) setDrawer(missing.id);
  }, [open, !!catalog, modules.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>) { setError(""); try { await fn(); reload(); } catch (e) { setError((e as Error).message); } }
  const setInstance = (m: ModuleInfo, on: boolean) => run(() => api(`/api/modules/${m.id}`, { method: "POST", json: { enabled: on } }));
  const setProject = (m: ModuleInfo, pid: string, on: boolean) => run(() => api(`/api/projects/${pid}/modules/${m.id}`, { method: "PUT", json: { enabled: on } }));
  const m = drawer ? manifest(drawer) : null;

  return (
    <>
      <Header title="Modules" sub="Chaque module apporte ses chiffres, ses onglets, ses blocs et ses outils pour les agents. Désactivé, tout disparaît ; ses données sont gardées." />
      <div className="mb-4 flex justify-end"><button onClick={() => go({ view: "connections", open: undefined })} className="text-sm text-muted hover:text-ink">Gérer les connexions →</button></div>
      {error && <p role="alert" className="mb-4 rounded-xl bg-negative-bg px-4 py-3 text-sm text-negative">{error}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {modules.map((mod) => (
          <Card key={mod.id} className={open === mod.id ? "ring-1 ring-accent" : ""}>
            <div id={`module-${mod.id}`} className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-base">{mod.name}</h2>
                <p className="mt-1 text-sm text-muted">{mod.description}</p>
              </div>
              {mod.core ? <Pill>Toujours actif</Pill> : <Pill tone={STATUS[mod.status][1]}>{STATUS[mod.status][0]}</Pill>}
            </div>
            {!mod.core && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {mod.connectors.map((c) => (
                  <Button key={c.id} variant="secondary" disabled={!admin} onClick={() => setDrawer(c.id)}>{c.connected ? `${manifest(c.id)?.name ?? c.id} : gérer` : `Connecter ${manifest(c.id)?.name ?? c.id}`}</Button>
                ))}
                {admin && <Button variant={mod.enabled ? "secondary" : "accent"} onClick={() => setInstance(mod, !mod.enabled)}>{mod.enabled ? "Désactiver" : "Activer"}</Button>}
              </div>
            )}
            {mod.enabled && !mod.core && mod.scope === "projet" && (projects?.length ?? 0) > 0 && (
              <fieldset className="mt-4">
                <legend className="text-xs text-muted">Pour quels projets ?</legend>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                  {projects!.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4" checked={mod.projects.includes(p.id)} onChange={(e) => setProject(mod, p.id, e.target.checked)} />{p.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </Card>
        ))}
      </div>
      {m && catalog && <Drawer key={m.id} m={m} catalog={catalog} onClose={() => { setDrawer(null); reload(); }} reload={async () => { await reloadCatalog(); reload(); }} />}
    </>
  );
}
