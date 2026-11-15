// D11 : visuels — rendu JPEG par le Chromium embarqué sans réseau, vidéo MP4 par ffmpeg, pièces jointes d'un brouillon.
process.env.SECRET = "s".repeat(40);
process.env.BROWSER_SANDBOX ??= "0"; // conteneur de test lancé en root : bac à sable indisponible (le rendu bloque de toute façon le réseau)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = join(tmpdir(), `st-visuels-${process.pid}`);
process.env.MEDIA_DIR = dir;
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { attachVisual, createVisual, ffmpegAvailable, getVisual, slideHtml } from "../visuals.ts";
import { mediaOf } from "../publishers/media.ts";

test("diapositive : texte échappé, couleur du thème, numéro et pied", () => {
  const html = slideHtml({ title: "<b>Titre</b>", text: "Texte" }, 1, 3, "carre", { color: "#123456", mode: "couleur", footer: "@moi" });
  assert.ok(html.includes("&lt;b&gt;Titre&lt;/b&gt;") && !html.includes("<b>Titre</b>"));
  assert.match(html, /background:#123456/); assert.match(html, /02 \/ 03/); assert.match(html, /@moi/);
});

test("rendu : une image JPEG par diapositive au bon format ; vidéo MP4 si ffmpeg ; jointe à un brouillon", async () => {
  try {
    db.prepare("INSERT INTO projects (id, name, crm_key, color, created_at) VALUES ('p-vis', 'Atelier', 'atelier', '#2255aa', 0)").run();
    const v = await createVisual({ project: "atelier", format: "portrait", slides: [{ title: "Accroche", text: "Sous-titre" }, { title: "Conseil 1" }, { title: "À vous de jouer" }], video: await ffmpegAvailable(), seconds: 1 });
    assert.equal(v.images, 3);
    assert.equal(v.theme.color, "#2255aa", "couleur du projet par défaut");
    const jpg = readFileSync(getVisual(v.id)!._files.images[0]);
    assert.equal(jpg.subarray(0, 3).toString("hex"), "ffd8ff", "JPEG");
    // Taille de l'image : marqueur SOF0/SOF2 du JPEG.
    const sof = jpg.findIndex((b, i) => b === 0xff && (jpg[i + 1] === 0xc0 || jpg[i + 1] === 0xc2));
    assert.deepEqual([jpg.readUInt16BE(sof + 7), jpg.readUInt16BE(sof + 5)], [1080, 1350]);
    if (v.video) assert.equal(readFileSync(getVisual(v.id)!._files.video!).subarray(4, 8).toString(), "ftyp", "MP4");
    const p = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: "Carrousel", project: "atelier", network: "instagram", text: "x" }) as any;
    assert.deepEqual(attachVisual(v.id, p.id, "images"), { attached: 3 });
    assert.deepEqual((mediaOf(p.id) as any[]).map((m) => m.mime), ["image/jpeg", "image/jpeg", "image/jpeg"]);
    await assert.rejects(createVisual({ slides: [] }), /Au moins une diapositive/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
