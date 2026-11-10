-- Searchtide Connect (Worker) — D1. Aucune donnée Stripe : uniquement des empreintes et stripe_user_id.
CREATE TABLE IF NOT EXISTS states (
  hash TEXT PRIMARY KEY, instance_id TEXT NOT NULL, host TEXT NOT NULL, challenge TEXT NOT NULL,
  return_url TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS codes (
  hash TEXT PRIMARY KEY, instance_id TEXT NOT NULL, host TEXT NOT NULL, challenge TEXT NOT NULL,
  return_url TEXT NOT NULL, stripe_user_id TEXT NOT NULL, livemode INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, instance_id TEXT NOT NULL, host TEXT NOT NULL, stripe_user_id TEXT NOT NULL,
  livemode INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL,
  day TEXT NOT NULL DEFAULT '', day_count INTEGER NOT NULL DEFAULT 0,
  minute TEXT NOT NULL DEFAULT '', minute_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(stripe_user_id);
CREATE INDEX IF NOT EXISTS tokens_last ON tokens(last_used);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, route TEXT NOT NULL,
  status INTEGER NOT NULL, instance_id TEXT
);
CREATE INDEX IF NOT EXISTS logs_at ON logs(at);
