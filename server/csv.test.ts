// C2 : export CSV — BOM côté navigateur, RFC 4180, apostrophe devant = + - @ (injection de formule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvText } from "../web/src/csv.ts";

test("C2 : échappement RFC 4180 et neutralisation des formules", () => {
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell("ligne\nsuivante"), '"ligne\nsuivante"');
  assert.equal(csvCell("=SUM(A1:A2)"), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell("+33600000000"), '"\'+33600000000"');
  assert.equal(csvCell("-1"), '"\'-1"');
  assert.equal(csvCell("@import"), '"\'@import"');
  assert.equal(csvCell("chemin/normal"), '"chemin/normal"');
  assert.equal(csvCell("\t=1+1"), '"\'\t=1+1"', "tabulation initiale neutralisée");
  assert.equal(csvCell("\r=1+1"), '"\'\r=1+1"', "retour chariot initial neutralisé");
  assert.equal(csvText([["a", 1], ["b", 2]]), '"a","1"\r\n"b","2"');
});

test("C2 : un nombre JS négatif reste un nombre, sans apostrophe", () => {
  const [cell] = csvText([[-12.5]]).split(",");
  assert.equal(cell, '"-12.5"');
});
