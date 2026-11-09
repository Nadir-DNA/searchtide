import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashboard, deleteDashboard, editWidgets, getDashboard, listDashboards } from "./dashboards.ts";
import { agentLog, createAgentKey, findAgent, logCall } from "./agents.ts";

test("pages : page par défaut, ajout, déplacement, modification et retrait de blocs", () => {
  const [home] = listDashboards();
  assert.equal(home.name, "Vue d'ensemble");
  assert.equal(home.widgets[0].type, "pulse");
  const p = createDashboard("Briefing", [{ type: "note", options: { text: "# Bonjour" } }], "test");
  assert.equal(p.widgets[0].size, "half"); // taille par défaut du type
  const id = p.widgets[0].id;
  let d = editWidgets(p.id, "hermes", { op: "add", widget: { type: "pulse" }, index: 0 });
  assert.equal(d.widgets[0].type, "pulse");
  d = editWidgets("briefing", "hermes", { op: "update", widget_id: id, patch: { options: { text: "Nouveau" }, size: "full" } });
  assert.equal(d.widgets[1].options.text, "Nouveau"); assert.equal(d.widgets[1].size, "full"); assert.equal(d.updated_by, "hermes");
  d = editWidgets(p.id, "hermes", { op: "move", widget_id: id, index: 0 });
  assert.equal(d.widgets[0].id, id);
  assert.throws(() => editWidgets(p.id, "x", { op: "add", widget: { type: "inconnu" } }));
  d = editWidgets(p.id, "hermes", { op: "remove", widget_id: id });
  assert.equal(d.widgets.length, 1);
  deleteDashboard(p.id);
  assert.throws(() => getDashboard(p.id));
  assert.throws(() => deleteDashboard(home.id), /dernière/);
});

test("clés d'agent : seule l'empreinte est gardée, journal par agent", () => {
  const k = createAgentKey("Codex", true);
  assert.match(k.key, /^ck_/);
  assert.deepEqual(findAgent(k.key), { name: "Codex", readOnly: true });
  assert.equal(findAgent("ck_faux"), null);
  logCall("Codex", "portfolio_overview", { days: 7 });
  assert.equal(agentLog(5, "Codex")[0].tool, "portfolio_overview");
});
