// Connecteur Google Agenda : se connecte depuis la page Rendez-vous (« Connecter Google Agenda », via le relais Searchtide Connect).
// Ce manifeste sert au test de la connexion, à son statut et à sa suppression dans Connexions.
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type TestResult } from "./types.ts";
import { whoami } from "../gcal.ts";

export const gcal: Connector = {
  id: "gcal", name: "Google Agenda", provider: "Google", monogram: "GA", category: "alertes", minutes: 1, singleton: true,
  description: "Relie votre Google Agenda au module Rendez-vous : vos événements bloquent les créneaux, chaque RDV s'y inscrit avec un lien Meet créé automatiquement. Se connecte depuis la page Rendez-vous.",
  unlocks: ["Créneaux libres selon votre vrai agenda", "Rendez-vous écrits dans Google Agenda", "Lien Google Meet automatique"],
  readPosts: ["POST https://"],
  fields: [],
  guide: [{ text: "Ouvrez la page Rendez-vous, puis « Connecter Google Agenda » : vous serez redirigé vers Google pour autoriser l'accès." }],
  revokeUrl: "https://myaccount.google.com/permissions",
  hint(c) { return `${c.config.email ?? "Google"} · via Searchtide Connect`; },
  async test(c: Cfg, ctx): Promise<TestResult> {
    if (!c.secrets.refresh_token) throw new ConnectorError("format", "Connexion incomplète : reconnectez Google Agenda depuis la page Rendez-vous.");
    const me = await whoami({ config: c.config, secrets: c.secrets }, ctx.fetch);
    return { ok: true, label: me.name, detail: `Agenda « ${me.name} » accessible`, settings: { email: me.name } };
  },
};
register(gcal);
