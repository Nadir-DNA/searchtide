// C8 : import CSV jour,valeur — valeur vide, date irréelle et nombre de lignes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDayValues } from "../web/src/day-values.ts";

test("C8 : une valeur vide n'est jamais importée comme 0", () => {
  const { rows, errors } = parseDayValues("2026-11-01,\n2026-11-02,12");
  assert.deepEqual(rows, [{ day: "2026-11-02", value: 12 }]);
  assert.match(errors[0], /valeur vide/);
});

test("C8 : une date irréelle est refusée (2026-99-99, 2026-02-30)", () => {
  const { rows, errors } = parseDayValues("2026-99-99,1\n2026-02-30,2\n2026-02-28,3");
  assert.deepEqual(rows, [{ day: "2026-02-28", value: 3 }]);
  assert.equal(errors.filter((e) => /date invalide/.test(e)).length, 2);
});

test("C8 : plus de 366 lignes est refusé en bloc ; en-tête et virgule décimale acceptés", () => {
  const many = ["jour;valeur", ...Array.from({ length: 367 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")},1`)].join("\n");
  const refused = parseDayValues(many);
  assert.deepEqual(refused.rows, []);
  assert.match(refused.errors.join(" "), /366 valeurs maximum/);
  const ok = parseDayValues("jour;valeur\n2026-11-01;4,5\n2026-11-02;7");
  assert.deepEqual(ok.rows[0], { day: "2026-11-01", value: 4.5 }, "séparateur ; et décimale ,");
  assert.equal(ok.rows.length, 2);
});

test("C8 : une virgule décimale sans point-virgule est une colonne en trop", () => {
  const { rows, errors } = parseDayValues("2026-11-01,12,5");
  assert.deepEqual(rows, []);
  assert.match(errors[0], /trop de colonnes/);
});

test("C8 : les formats non décimaux (0x10, 1e3) sont refusés", () => {
  const { rows, errors } = parseDayValues("2026-11-01,0x10\n2026-11-02,1e3\n2026-11-03;-2,5");
  assert.deepEqual(rows, [{ day: "2026-11-03", value: -2.5 }]);
  assert.equal(errors.length, 2);
  assert.match(errors.join(" "), /non numérique/);
});
