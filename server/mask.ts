// Masquage unique des secrets : garde le nom du champ, remplace la valeur, récursif objets/tableaux.
const SENSITIVE = /(secret|token|pass(word|wd)?|api[_-]?key|authorization|private[_-]?key|credential(s)?|bearer)$/i;

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? "•••" : maskSecrets(v)]));
  }
  return typeof value === "string" ? maskUrlSecrets(value) : value;
}

/** Vrai si une clé sensible apparaît, à n'importe quel niveau. */
export function hasSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => SENSITIVE.test(k) || hasSecretKey(v));
  }
  return false;
}

export const SECRET_REFS = ["env", "connection_id"] as const;
const SECRET_REF_SET = new Set<string>(SECRET_REFS);
export const SECRET_CONFIG_ERROR = "Les secrets se saisissent par variable d'environnement (env)";
const SENSITIVE_PARAM = /(secret|token|pass(word|wd)?|api[_-]?key|authorization|private[_-]?key|credential(s)?|bearer|sig(nature)?|auth|key)$/;
const normParam = (n: string) => n.toLowerCase().replace(/[^a-z]/g, "");
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

export function maskUrlSecrets(text: string): string {
  return text.replace(URL_RE, (raw) => {
    try {
      const u = new URL(raw.replace(/[.,;:)]+$/, ""));
      let changed = false;
      if (u.username || u.password) { u.username = "•••"; u.password = ""; changed = true; }
      const maskParams = (params: URLSearchParams) => { for (const k of [...params.keys()]) if (SENSITIVE_PARAM.test(normParam(k))) { params.set(k, "•••"); changed = true; } };
      maskParams(u.searchParams);
      const frag = u.hash.replace(/^#/, "");
      if (frag) { const f = new URLSearchParams(frag); maskParams(f); if (changed) u.hash = f.toString(); }
      return changed ? u.toString().replaceAll("%E2%80%A2%E2%80%A2%E2%80%A2", "•••") : raw;
    } catch { return raw; }
  });
}

export function hasUrlSecret(text: string): boolean {
  for (const raw of text.match(URL_RE) ?? []) {
    try {
      const u = new URL(raw.replace(/[.,;:)]+$/, ""));
      if (u.username || u.password) return true;
      const names = [...u.searchParams.keys(), ...new URLSearchParams(u.hash.replace(/^#/, "")).keys()];
      if (names.some((n) => SENSITIVE_PARAM.test(normParam(n)))) return true;
    } catch { /* URL incomplète */ }
  }
  return false;
}
