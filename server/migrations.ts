// Migrations de schéma numérotées : chacune ne s'applique qu'une fois, dans l'ordre, dans une transaction.
import { db } from "./db.ts";

db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");

export function migrate(name: string, sql: string) {
  if (db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(name)) return false;
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    db.exec("COMMIT");
    return true;
  } catch (e) { db.exec("ROLLBACK"); throw new Error(`Migration ${name} : ${(e as Error).message}`); }
}
