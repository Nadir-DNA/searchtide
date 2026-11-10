// Stockage du relais Searchtide Connect. D1 en production, mémoire en test.
// Aucune donnée Stripe n'est conservée : seulement stripe_user_id, des empreintes et des compteurs.

export type StateRow = { instanceId: string; host: string; challenge: string; returnUrl: string; expiresAt: number };
export type CodeRow = StateRow & { stripeUserId: string; livemode: boolean };
export type TokenRow = {
  instanceId: string; host: string; stripeUserId: string; livemode: boolean;
  createdAt: number; lastUsed: number; day: string; dayCount: number; minute: string; minuteCount: number;
};

export interface Store {
  createState(hash: string, row: StateRow): Promise<void>;
  getState(hash: string, now: number): Promise<StateRow | null>;
  takeState(hash: string, now: number): Promise<StateRow | null>;
  createCode(hash: string, row: CodeRow): Promise<void>;
  getCode(hash: string, now: number): Promise<CodeRow | null>;
  takeCode(hash: string, now: number): Promise<CodeRow | null>;
  useCode(hash: string, now: number): Promise<boolean>;
  createToken(hash: string, row: TokenRow): Promise<void>;
  findToken(hash: string): Promise<TokenRow | null>;
  findByStripeUser(stripeUserId: string): Promise<TokenRow | null>;
  quota(hash: string, now: number, day: string, minute: string, maxDay: number, maxMinute: number): Promise<"ok" | "day" | "minute" | "none">;
  deleteToken(hash: string): Promise<void>;
  deleteByStripeUser(stripeUserId: string): Promise<void>;
  purge(now: number): Promise<void>;
  log(route: string, status: number, instanceId: string | null, now: number): Promise<void>;
  rate(key: string, window: string, max: number): Promise<boolean>;
}

export const sha256 = async (text: string) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/* ── D1 ───────────────────────────────────────────────────────────────────── */
type D1Prepared = {
  bind(...v: unknown[]): D1Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};
export type D1 = { prepare(sql: string): D1Prepared };

const rowState = (r: any): StateRow => ({ instanceId: r.instance_id, host: r.host, challenge: r.challenge, returnUrl: r.return_url, expiresAt: Number(r.expires_at) });
const rowCode = (r: any): CodeRow => ({ ...rowState(r), stripeUserId: r.stripe_user_id, livemode: !!r.livemode });
const rowToken = (r: any): TokenRow => ({
  instanceId: r.instance_id, host: r.host, stripeUserId: r.stripe_user_id, livemode: !!r.livemode,
  createdAt: Number(r.created_at), lastUsed: Number(r.last_used), day: r.day, dayCount: Number(r.day_count), minute: r.minute, minuteCount: Number(r.minute_count),
});

export class D1Store implements Store {
  db: D1;
  constructor(db: D1) { this.db = db; }
  async createState(hash: string, s: StateRow) {
    await this.db.prepare("INSERT INTO states (hash, instance_id, host, challenge, return_url, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, 0)")
      .bind(hash, s.instanceId, s.host, s.challenge, s.returnUrl, s.expiresAt).run();
  }
  async getState(hash: string, now: number) {
    const r = await this.db.prepare("SELECT * FROM states WHERE hash = ? AND used = 0 AND expires_at > ?").bind(hash, now).first();
    return r ? rowState(r) : null;
  }
  async takeState(hash: string, now: number) {
    const r = await this.db.prepare("UPDATE states SET used = 1 WHERE hash = ? AND used = 0 AND expires_at > ? RETURNING *").bind(hash, now).first();
    return r ? rowState(r) : null;
  }
  async createCode(hash: string, c: CodeRow) {
    await this.db.prepare("INSERT INTO codes (hash, instance_id, host, challenge, return_url, stripe_user_id, livemode, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)")
      .bind(hash, c.instanceId, c.host, c.challenge, c.returnUrl, c.stripeUserId, c.livemode ? 1 : 0, c.expiresAt).run();
  }
  async getCode(hash: string, now: number) {
    const r = await this.db.prepare("SELECT * FROM codes WHERE hash = ? AND used = 0 AND expires_at > ?").bind(hash, now).first();
    return r ? rowCode(r) : null;
  }
  async takeCode(hash: string, now: number) {
    const r = await this.db.prepare("UPDATE codes SET used = 1 WHERE hash = ? AND used = 0 AND expires_at > ? RETURNING *").bind(hash, now).first();
    return r ? rowCode(r) : null;
  }
  async useCode(hash: string, now: number) {
    const r = await this.db.prepare("UPDATE codes SET used = 1 WHERE hash = ? AND used = 0 AND expires_at > ? RETURNING hash").bind(hash, now).first();
    return !!r;
  }
  async createToken(hash: string, t: TokenRow) {
    await this.db.prepare("INSERT INTO tokens (hash, instance_id, host, stripe_user_id, livemode, created_at, last_used, day, day_count, minute, minute_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(hash, t.instanceId, t.host, t.stripeUserId, t.livemode ? 1 : 0, t.createdAt, t.lastUsed, t.day, t.dayCount, t.minute, t.minuteCount).run();
  }
  async findToken(hash: string) {
    const r = await this.db.prepare("SELECT * FROM tokens WHERE hash = ?").bind(hash).first();
    return r ? rowToken(r) : null;
  }
  async findByStripeUser(id: string) {
    const r = await this.db.prepare("SELECT * FROM tokens WHERE stripe_user_id = ? LIMIT 1").bind(id).first();
    return r ? rowToken(r) : null;
  }
  async quota(hash: string, now: number, day: string, minute: string, maxDay: number, maxMinute: number) {
    const t = await this.findToken(hash);
    if (!t) return "none" as const;
    if (t.day === day && t.dayCount >= maxDay) return "day" as const;
    if (t.minute === minute && t.minuteCount >= maxMinute) return "minute" as const;
    const dayCount = t.day === day ? t.dayCount + 1 : 1;
    const minuteCount = t.minute === minute ? t.minuteCount + 1 : 1;
    await this.db.prepare("UPDATE tokens SET last_used = ?, day = ?, day_count = ?, minute = ?, minute_count = ? WHERE hash = ?")
      .bind(now, day, dayCount, minute, minuteCount, hash).run();
    return "ok" as const;
  }
  async deleteToken(hash: string) { await this.db.prepare("DELETE FROM tokens WHERE hash = ?").bind(hash).run(); }
  async deleteByStripeUser(id: string) { await this.db.prepare("DELETE FROM tokens WHERE stripe_user_id = ?").bind(id).run(); }
  async purge(now: number) {
    await this.db.prepare("DELETE FROM states WHERE expires_at < ? OR used = 1").bind(now).run();
    await this.db.prepare("DELETE FROM codes WHERE expires_at < ? OR used = 1").bind(now).run();
    await this.db.prepare("DELETE FROM logs WHERE at < ?").bind(now - 7 * 86400_000).run();
    await this.db.prepare("DELETE FROM tokens WHERE last_used < ?").bind(now - 180 * 86400_000).run();
  }
  async log(route: string, status: number, instanceId: string | null, now: number) {
    await this.db.prepare("INSERT INTO logs (at, route, status, instance_id) VALUES (?, ?, ?, ?)").bind(now, route, status, instanceId).run();
  }
  async rate(key: string, window: string, max: number) {
    const r = await this.db.prepare("INSERT INTO limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN limits.window = excluded.window THEN limits.count + 1 ELSE 1 END, window = excluded.window RETURNING count")
      .bind(key, window).first() as { count: number } | null;
    return !!r && Number(r.count) <= max;
  }
}

/* ── Mémoire (tests) ──────────────────────────────────────────────────────── */
export class MemoryStore implements Store {
  states = new Map<string, StateRow & { used: boolean }>();
  codes = new Map<string, CodeRow & { used: boolean }>();
  tokens = new Map<string, TokenRow>();
  logs: { route: string; status: number; instanceId: string | null; at: number }[] = [];
  async createState(hash: string, s: StateRow) { this.states.set(hash, { ...s, used: false }); }
  async getState(hash: string, now: number) { const s = this.states.get(hash); return s && !s.used && s.expiresAt > now ? s : null; }
  async takeState(hash: string, now: number) { const s = this.states.get(hash); if (!s || s.used || s.expiresAt <= now) return null; s.used = true; return s; }
  async createCode(hash: string, c: CodeRow) { this.codes.set(hash, { ...c, used: false }); }
  async getCode(hash: string, now: number) { const c = this.codes.get(hash); return c && !c.used && c.expiresAt > now ? c : null; }
  async takeCode(hash: string, now: number) { const c = this.codes.get(hash); if (!c || c.used || c.expiresAt <= now) return null; c.used = true; return c; }
  async useCode(hash: string, now: number) { const c = this.codes.get(hash); if (!c || c.used || c.expiresAt <= now) return false; c.used = true; return true; }
  async createToken(hash: string, t: TokenRow) { this.tokens.set(hash, t); }
  async findToken(hash: string) { return this.tokens.get(hash) ?? null; }
  async findByStripeUser(id: string) { for (const t of this.tokens.values()) if (t.stripeUserId === id) return t; return null; }
  async quota(hash: string, now: number, day: string, minute: string, maxDay: number, maxMinute: number) {
    const t = this.tokens.get(hash); if (!t) return "none" as const;
    if (t.day === day && t.dayCount >= maxDay) return "day" as const;
    if (t.minute === minute && t.minuteCount >= maxMinute) return "minute" as const;
    t.lastUsed = now; t.dayCount = t.day === day ? t.dayCount + 1 : 1; t.day = day;
    t.minuteCount = t.minute === minute ? t.minuteCount + 1 : 1; t.minute = minute;
    return "ok" as const;
  }
  async deleteToken(hash: string) { this.tokens.delete(hash); }
  async deleteByStripeUser(id: string) { for (const [h, t] of this.tokens) if (t.stripeUserId === id) this.tokens.delete(h); }
  async purge(now: number) {
    for (const [h, s] of this.states) if (s.used || s.expiresAt < now) this.states.delete(h);
    for (const [h, c] of this.codes) if (c.used || c.expiresAt < now) this.codes.delete(h);
    this.logs = this.logs.filter((l) => l.at >= now - 7 * 86400_000);
    for (const [h, t] of this.tokens) if (t.lastUsed < now - 180 * 86400_000) this.tokens.delete(h);
  }
  async log(route: string, status: number, instanceId: string | null, now: number) { this.logs.push({ route, status, instanceId, at: now }); }
  rates = new Map<string, { window: string; count: number }>();
  async rate(key: string, window: string, max: number) {
    const r = this.rates.get(key);
    const next = r && r.window === window ? r.count + 1 : 1;
    this.rates.set(key, { window, count: next });
    return next <= max;
  }
}
