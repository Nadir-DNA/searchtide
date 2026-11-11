// Cache mémoire des réponses (B2) : 30 s, affichage immédiat puis relecture systématique.
// Une mutation appelle reload(), qui relit le réseau sans attendre l'expiration.
export const CACHE_MS = 30_000;
const store = new Map<string, { at: number; data: unknown }>();

export function readCache<T>(key: string, now = Date.now()): T | null {
  const hit = store.get(key);
  return hit && now - hit.at < CACHE_MS ? (hit.data as T) : null;
}

export function writeCache(key: string, data: unknown, now = Date.now()) {
  store.set(key, { at: now, data });
}

export function clearCache() { store.clear(); }
