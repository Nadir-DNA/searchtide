import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.DATABASE_PATH ?? "data/searchtide.db";
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gsc_property TEXT,              -- ex. "sc-domain:exemple.com"
  created_at INTEGER NOT NULL
);

-- Une ligne par page vue ou événement personnalisé
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,            -- millisecondes UTC
  day TEXT NOT NULL,              -- AAAA-MM-JJ (UTC)
  visitor TEXT NOT NULL,          -- empreinte anonyme, change chaque jour
  type TEXT NOT NULL,             -- 'pageview' | 'event'
  name TEXT,
  path TEXT NOT NULL,
  referrer TEXT,                  -- domaine référent
  channel TEXT NOT NULL,          -- direct | search | social | ai | referral | email | paid
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  country TEXT, device TEXT, browser TEXT, os TEXT, lang TEXT
);
CREATE INDEX IF NOT EXISTS events_site_day ON events(site_id, day);

-- Search Analytics par jour × requête × page
CREATE TABLE IF NOT EXISTS gsc_rows (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  position REAL NOT NULL,
  PRIMARY KEY (site_id, day, query, page)
);

CREATE TABLE IF NOT EXISTS gsc_syncs (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  synced_at INTEGER NOT NULL,
  last_day TEXT,
  error TEXT
);
`);

/** Jour civil (AAAA-MM-JJ) dans le fuseau de l'instance : une visite à 0 h 30 compte pour le bon jour. */
const DAY_TZ = process.env.DAY_TZ ?? "Europe/Paris";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: DAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const localDay = (t: number | Date = Date.now()) => dayFmt.format(t);

export type Site = { id: string; domain: string; name: string; gsc_property: string | null; created_at: number };
