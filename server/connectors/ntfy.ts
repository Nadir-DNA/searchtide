// Connecteur ntfy : alertes sur le téléphone. Le sujet fait office de mot de passe (secret). Un seul compte (R9).
import { register } from "./registry.ts";
import { ConnectorError, type Connector, type TestResult } from "./types.ts";

export const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
export type NtfySetup = { server: string; topic: string; token?: string };

/** Publie une notification (JSON). Lève ConnectorError sur refus. */
export async function ntfyPublish(s: NtfySetup, n: { title: string; message: string; priority?: number; click?: string }, doFetch: typeof fetch) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  const res = await doFetch(`${s.server.replace(/\/$/, "")}/`, { method: "POST", headers, body: JSON.stringify({ topic: s.topic, title: n.title, message: n.message, priority: n.priority ?? 3, ...(n.click ? { click: n.click } : {}) }) });
  if (res.status === 401 || res.status === 403) throw new ConnectorError("auth", "ntfy refuse l'accès : vérifiez le jeton, ou le droit d'écrire sur ce sujet.");
  if (!res.ok) throw new ConnectorError("other", `ntfy ${res.status} : ${(await res.text().catch(() => "")).slice(0, 120)}`);
}

export const ntfy: Connector = {
  id: "ntfy", name: "ntfy", provider: "ntfy", monogram: "NT", category: "alertes", minutes: 1, singleton: true, sideEffects: ["notify"],
  description: "Reçoit les alertes sur votre téléphone : site hors ligne, relevé en erreur, forte baisse, nouvelle vente.",
  unlocks: ["Alertes sur le téléphone"],
  fields: [
    { key: "topic", label: "Sujet", type: "text", secret: true, required: true, generate: "topic", help: "Généré pour vous : il fait office de mot de passe, gardez-le pour vous." },
    { key: "server", label: "Serveur", type: "url", default: "https://ntfy.sh", help: "ntfy.sh par défaut ; l'adresse de votre serveur si vous l'hébergez." },
    { key: "token", label: "Jeton d'accès", type: "text", secret: true, help: "Facultatif : seulement pour un serveur protégé." },
  ],
  guide: [
    { text: "Installez l'application ntfy sur votre téléphone.", url: "https://ntfy.sh" },
    { text: "Abonnez-vous au sujet affiché après l'enregistrement (bouton Copier)." },
    { text: "Utilisez « Tester » : une notification arrive sur le téléphone." },
  ],
  hint(c) { let host = String(c.config.server || "https://ntfy.sh"); try { host = new URL(host).host; } catch { /* garde la valeur brute */ } return `${host} · sujet masqué`; },
  async test(c, ctx): Promise<TestResult> {
    const topic = String(c.secrets.topic ?? "");
    if (!TOPIC.test(topic)) throw new ConnectorError("format", "Le sujet n'accepte que lettres, chiffres, tiret et tiret bas (64 caractères au plus).");
    const server = String(c.config.server || "https://ntfy.sh");
    let url: URL;
    try { url = new URL(server); if (!/^https?:$/.test(url.protocol)) throw 0; } catch { throw new ConnectorError("format", "L'adresse du serveur doit commencer par https://."); }
    await ntfyPublish({ server, topic, token: c.secrets.token || undefined }, { title: "Searchtide", message: "Les notifications fonctionnent." }, ctx.fetch);
    return { ok: true, label: url.host, detail: "Notification envoyée : vérifiez votre téléphone." };
  },
};
register(ntfy);
