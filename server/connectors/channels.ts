// Canaux d'envoi (e-mail, ntfy) utilisés par le rapport, les alertes et la prospection.
// Une connexion faite dans l'interface l'emporte sur les variables d'environnement, qui restent un secours (§1 de la spec).
import { createTransport } from "nodemailer";
import { connections, getSecrets } from "../connections.ts";
import { smtpOptions } from "./smtp.ts";
import { TOPIC, type NtfySetup } from "./ntfy.ts";
import { currentCtx } from "./use.ts";
import type { Mailer } from "./types.ts";

export type MailSetup = { transport: Mailer; from: string; to: string; via: "connexion" | "env" };

/** Compte e-mail à utiliser, ou null. Ne lève jamais : des secrets illisibles (SECRET changé) donnent null. */
export function mailSetup(): MailSetup | null {
  const conn = connections("smtp")[0];
  if (conn) {
    try {
      const s = getSecrets(conn), c = conn.config;
      return { transport: currentCtx().smtp(smtpOptions(c, String(s.pass ?? ""))), from: String(c.from || c.user), to: String(c.to || c.user), via: "connexion" };
    } catch { /* illisible : on essaie la variable d'environnement */ }
  }
  if (process.env.SMTP_URL) return { transport: createTransport(process.env.SMTP_URL) as unknown as Mailer, from: process.env.REPORT_FROM || process.env.REPORT_TO || "", to: process.env.REPORT_TO || "", via: "env" };
  return null;
}

export function ntfySetup(): (NtfySetup & { via: "connexion" | "env" }) | null {
  const conn = connections("ntfy")[0];
  if (conn) {
    try {
      const s = getSecrets(conn);
      if (TOPIC.test(String(s.topic ?? ""))) return { server: String(conn.config.server || "https://ntfy.sh"), topic: String(s.topic), token: s.token || undefined, via: "connexion" };
    } catch { /* illisible : repli */ }
  }
  if (process.env.NTFY_TOPIC) return { server: "https://ntfy.sh", topic: process.env.NTFY_TOPIC, via: "env" };
  return null;
}
