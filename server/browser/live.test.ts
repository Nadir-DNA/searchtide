// B2 : affichage intégré — ticket à usage unique, images, relais d'entrées non journalisées, session scellée.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SECRET = "s".repeat(40);   // le coffre des sessions exige un SECRET valable
import { db } from "../db.ts";
import { startFixtures } from "./fixtures.ts";
import { closeLive, livePage, liveStatus, openBrowserSession, revokeBrowserSession, sendInput, startLive, subscribe, validateInput } from "./live.ts";

const waitUntil = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("condition non atteinte");
};

test("B2 : entrées — schéma strict, bornes, types inconnus refusés", () => {
  assert.deepEqual(validateInput({ type: "text", text: "abc" }), { type: "text", text: "abc" });
  assert.deepEqual(validateInput({ type: "click", x: 10, y: 20 }), { type: "click", x: 10, y: 20, button: "left" });
  for (const bad of [
    { type: "text", text: "x".repeat(1001) },
    { type: "move", x: -1, y: 0 },
    { type: "move", x: 0, y: 999999 },
    { type: "wheel", deltaY: 999999 },
    { type: "key", key: "" },
    { type: "script", code: "alert(1)" },
    null,
    "texte",
  ]) assert.throws(() => validateInput(bad), /invalide|inconnu/i);
});

test("B2 : vue — image reçue, ticket rejoué refusé, saisie relayée sans journal, session scellée puis révoquée", async () => {
  const f = await startFixtures();
  const live = await startLive({ url: `${f.url}/composer`, fixturePort: f.port, sandbox: false });
  const frames: string[] = [];
  const seen = new Set<string>();
  let unsubscribe = () => { /* remplacé ci-dessous */ };
  try {
    unsubscribe = subscribe(live.ticket, (jpeg) => { frames.push(jpeg); seen.add(jpeg); });
    await waitUntil(() => frames.length > 0);
    assert.ok(frames[0].length > 100, "image JPEG non vide");
    assert.equal(liveStatus().viewers, 1);

    // Ticket à usage unique : une deuxième vue est refusée, un mauvais ticket aussi.
    assert.throws(() => subscribe(live.ticket, () => { /* refusé */ }), /déjà connectée/);
    assert.throws(() => subscribe("mauvais-ticket", () => { /* refusé */ }), /invalide/);

    // La saisie relayée arrive dans la page (test seulement : focus direct, pas de coordonnées).
    const page = livePage()!;
    await page.getByLabel("Titre").focus();
    await sendInput(live.ticket, { type: "text", text: "Saisie-test-secrete" });
    assert.equal(await page.getByLabel("Titre").inputValue(), "Saisie-test-secrete");
    await assert.rejects(sendInput("mauvais-ticket", { type: "text", text: "x" }), /absente ou fermée/);
    await assert.rejects(sendInput(live.ticket, { type: "text", text: "x".repeat(2000) }), /Texte invalide/);

    // Session : cookie posé dans la vue, état scellé à la fermeture.
    await page.context().addCookies([{ name: "st_live", value: "cookie-secret-vue", url: f.url }]);
    const closed = await closeLive({ accountId: "acc-1", projectId: "proj-1" });
    assert.equal(closed.saved, true);
    assert.equal(liveStatus().open, false);

    const row = db.prepare("SELECT sealed, project_id FROM browser_sessions WHERE account_id = ?").get("acc-1") as { sealed: string; project_id: string };
    assert.equal(row.project_id, "proj-1");
    assert.equal(row.sealed.includes("cookie-secret-vue"), false, "aucun cookie en clair dans la base");

    const state = openBrowserSession("acc-1")!;
    const cookies = state.cookies as { name: string; value: string }[];
    assert.equal(cookies.find((c) => c.name === "st_live")?.value, "cookie-secret-vue", "session rechargée en mémoire");

    // Ni la saisie ni le cookie n'apparaissent dans les journaux applicatifs.
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name).filter((n) => n === "security_events" || n === "agent_log");
    const dump = tables.map((n) => JSON.stringify(db.prepare(`SELECT * FROM ${n}`).all())).join("");
    assert.equal(dump.includes("Saisie-test-secrete"), false);
    assert.equal(dump.includes("cookie-secret-vue"), false);

    assert.equal(revokeBrowserSession("acc-1"), true);
    assert.equal(openBrowserSession("acc-1"), null, "révocation : plus aucun état");
  } finally {
    unsubscribe();
    await closeLive().catch(() => { /* déjà fermée */ });
    await f.close();
  }
});

test("B2 : hôte non autorisé refusé avant lancement", async () => {
  const f = await startFixtures();
  try {
    await assert.rejects(startLive({ url: "https://exemple.test/", fixturePort: f.port, sandbox: false }), /Bac à sable inactif/);
    assert.equal(liveStatus().open, false);
  } finally { await f.close(); }
});
