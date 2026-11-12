// Registre des modules : enregistrement contrôlé, lecture, et vérification d'un manifeste (sert aussi aux modules privés).
import { get as getConnector } from "../connectors/registry.ts";
import "../connectors/index.ts";
import { CATEGORIES, type Module } from "./types.ts";

const modules = new Map<string, Module>();

/** Défauts d'un manifeste, en clair. Vide si le module est conforme. */
export function checkModule(m: Module): string[] {
  const bad: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(m.id)) bad.push(`identifiant invalide : ${m.id}`);
  if (!CATEGORIES.includes(m.category)) bad.push(`catégorie inconnue : ${m.category}`);
  if (!["instance", "projet"].includes(m.scope)) bad.push(`portée inconnue : ${m.scope}`);
  for (const c of m.connectors ?? []) if (!getConnector(c)) bad.push(`connecteur inconnu : ${c}`);
  for (const w of Object.keys(m.widgets ?? {})) {
    const other = [...modules.values()].find((x) => x.id !== m.id && x.widgets?.[w]);
    if (other) bad.push(`bloc « ${w} » déjà déclaré par ${other.id}`);
  }
  return bad;
}

export function registerModule(m: Module): Module {
  if (modules.has(m.id)) throw new Error(`Module déjà enregistré : ${m.id}`);
  const bad = checkModule(m);
  if (bad.length) throw new Error(`Module ${m.id} refusé : ${bad.join(", ")}`);
  modules.set(m.id, m);
  return m;
}
export const getModule = (id: string) => modules.get(id);
export const allModules = () => [...modules.values()];
/** Pour les tests uniquement. */
export const unregisterModule = (id: string) => modules.delete(id);
