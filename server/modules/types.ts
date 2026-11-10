// Manifeste d'un module : tout ce qu'une capacité ajoute au produit (KPI, onglets, blocs, outils MCP, tâches de fond).
// Un module s'appuie sur zéro, un ou plusieurs connecteurs (server/connectors) sans les remplacer.
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Field } from "../connectors/types.ts";

export type Size = "quarter" | "third" | "half" | "two-thirds" | "full";
export type WidgetDef = { label: string; description: string; size: Size; options: Record<string, string> };
export type KpiOffer = { module: string; connection_id: string | null; kpi: string; label: string; unit?: string; params?: Field[]; already?: boolean };
export type Action = { key: string; project_id: string; text: string; metric?: string; to: Record<string, string> };
export type Job = { id: string; every: string; run: () => Promise<void> };
export type Category = "trafic" | "referencement" | "revenus" | "produit" | "commercial" | "notifications";
export const CATEGORIES: Category[] = ["trafic", "referencement", "revenus", "produit", "commercial", "notifications"];

export interface Module {
  id: string;
  name: string;
  /** Ce que l'utilisateur obtient, en toutes lettres. */
  description: string;
  category: Category;
  /** Toujours actif, non désactivable. */
  core?: boolean;
  /** projet : s'active projet par projet. */
  scope: "instance" | "projet";
  /** Connecteurs dont il dépend (identifiants du registre des connecteurs). */
  connectors?: string[];
  /** Réglages par projet (propriété Search Console, compte Stripe…). */
  projectSettings?: Field[];
  kpis?: (projectId: string) => KpiOffer[];
  tabs?: { id: string; label: string }[];
  widgets?: Record<string, WidgetDef>;
  actions?: (projectId: string) => Promise<Action[]> | Action[];
  routes?: (app: Hono) => void;
  mcp?: (server: McpServer, o: { readOnly: boolean; agent: string }) => void;
  jobs?: Job[];
  /** Date du dernier passage sur un vrai compte. */
  verified?: string;
}
