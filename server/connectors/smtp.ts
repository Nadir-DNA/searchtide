// Connecteur SMTP : rapport hebdomadaire, alertes par e-mail et prospection. Un seul compte (R9).
// Préréglage Gmail : serveur smtp.gmail.com, port 465 (SSL), mot de passe d'application (validation en 2 étapes requise).
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type SmtpOptions, type TestResult } from "./types.ts";

const GMAIL = { host: "smtp.gmail.com", port: 465, security: "ssl" };

/** Options de transport nodemailer depuis les réglages (préréglage + valeurs saisies) et le mot de passe. */
export function smtpOptions(config: Record<string, any>, pass: string): SmtpOptions {
  const p = config.preset === "gmail" ? GMAIL : ({} as Partial<typeof GMAIL>);
  const host = String(config.host || p.host || "").trim();
  const port = Number(config.port || p.port || 587);
  const security = String(config.security || p.security || (port === 465 ? "ssl" : "starttls"));
  return { host, port, secure: security === "ssl", requireTLS: security === "starttls", auth: { user: String(config.user ?? ""), pass } };
}

const authFailure = "Identifiant ou mot de passe refusé. Avec Gmail, utilisez un mot de passe d'application, pas votre mot de passe.";

function mapError(e: any, host: string, port: number): ConnectorError {
  const code = String(e?.code ?? ""), rc = Number(e?.responseCode ?? 0);
  if (code === "EAUTH" || [530, 534, 535].includes(rc)) return new ConnectorError("auth", authFailure);
  if (/TIMEDOUT|ETIMEDOUT|ESOCKETTIMEDOUT/.test(code) || /timed? ?out/i.test(String(e?.message))) return new ConnectorError("timeout", "Le serveur SMTP ne répond pas. Réessayez dans un instant.");
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "ESOCKET", "EDNS"].includes(code)) return new ConnectorError("other", `Connexion impossible à ${host}:${port} : vérifiez l'hôte, le port et le type de sécurité.`);
  return new ConnectorError("other", String(e?.message ?? e).slice(0, 200));
}

export const smtp: Connector = {
  id: "smtp", name: "E-mail (SMTP)", provider: "Le serveur SMTP", monogram: "EM", category: "alertes", minutes: 5, singleton: true, sideEffects: ["mail"],
  description: "Envoie le rapport de la semaine et les alertes par e-mail. Un e-mail d'essai est envoyé à l'enregistrement.",
  unlocks: ["Rapport hebdomadaire par e-mail", "Alertes par e-mail", "Envois de prospection"],
  fields: [
    { key: "preset", label: "Fournisseur", type: "select", default: "gmail", options: [{ value: "gmail", label: "Gmail" }, { value: "other", label: "Autre serveur SMTP" }] },
    { key: "host", label: "Serveur (autre que Gmail)", type: "text", placeholder: "smtp.exemple.com", help: "Laissez vide avec Gmail." },
    { key: "port", label: "Port", type: "number", placeholder: "465 ou 587", help: "Laissez vide avec Gmail." },
    { key: "security", label: "Sécurité", type: "select", options: [{ value: "ssl", label: "SSL/TLS (port 465)" }, { value: "starttls", label: "STARTTLS (port 587)" }], help: "Laissez vide avec Gmail." },
    { key: "user", label: "Identifiant", type: "text", required: true, placeholder: "vous@gmail.com" },
    { key: "pass", label: "Mot de passe", type: "text", secret: true, required: true, help: "Avec Gmail : le mot de passe d'application de 16 caractères, pas votre mot de passe." },
    { key: "from", label: "Expéditeur", type: "text", placeholder: "Searchtide <vous@gmail.com>", help: "Par défaut : l'identifiant." },
    { key: "to", label: "Destinataire du rapport", type: "text", placeholder: "vous@gmail.com", help: "Par défaut : l'identifiant." },
  ],
  guide: [
    { text: "Gmail : activez la validation en 2 étapes de votre compte Google." },
    { text: "Créez un mot de passe d'application (aide Google).", url: "https://support.google.com/accounts/answer/185833" },
    { text: "Collez les 16 caractères dans « Mot de passe » (sans espaces)." },
  ],
  hint(c) { const o = smtpOptions(c.config, ""); return `${c.config.user ?? ""} · ${o.host}`; },
  async test(c: Cfg, ctx): Promise<TestResult> {
    const o = smtpOptions(c.config, String(c.secrets.pass ?? ""));
    if (!o.host) throw new ConnectorError("format", "Indiquez le serveur SMTP (ou choisissez Gmail).");
    const from = String(c.config.from || c.config.user), to = String(c.config.to || c.config.user);
    if (!to.includes("@")) throw new ConnectorError("format", "Le destinataire doit être une adresse e-mail.");
    const mailer = ctx.smtp(o);
    try {
      await mailer.verify();
      await mailer.sendMail({ from, to, subject: "Searchtide : e-mail d'essai", text: "Cet e-mail confirme que Searchtide peut envoyer des messages avec ce compte. Vous pouvez le supprimer." });
    } catch (e) { throw mapError(e, o.host, o.port); }
    return { ok: true, label: String(c.config.user), detail: `E-mail d'essai envoyé à ${to}` };
  },
};
register(smtp);
