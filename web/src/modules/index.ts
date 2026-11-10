// Registre côté client : l'état des modules (GET /api/modules) pour construire le menu, les onglets et les blocs.
import { useData } from "../App";

export type ModuleInfo = { id: string; name: string; description: string; category: string; core: boolean; scope: "instance" | "projet";
  enabled: boolean; status: "inactif" | "actif" | "a-reconnecter"; projects: string[]; connectors: { id: string; connected: boolean }[]; tabs?: { id: string; label: string }[] };

export function useModules() {
  const { data, reload } = useData<ModuleInfo[]>("/api/modules");
  const modules = data ?? [];
  /** Actif sur l'instance, et pour ce projet si le module s'active projet par projet. */
  const active = (id: string, projectId?: string) => {
    const m = modules.find((x) => x.id === id);
    if (!m?.enabled) return false;
    return m.core || m.scope === "instance" || !projectId || m.projects.includes(projectId);
  };
  return { modules, loaded: !!data, active, reload };
}
