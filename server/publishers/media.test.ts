// J4 : médias — signature réelle, plafond, lecture admin seule, validation par réseau, suppression.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { login, startServer, tempDb } from "../test-server.ts";

const DAY = new Date().toISOString().slice(0, 10);
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

test("J4 médias : signature vérifiée, lecture admin, validation Instagram, suppression", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { MEDIA_DIR: join(t.dir, "media") });
  try {
    const cookie = await login(s.base);
    const admin = { Cookie: cookie, "content-type": "application/json" };
    const project = `media-${Date.now().toString(36)}`;
    const publication = await (await fetch(`${s.base}/api/publications`, { method: "POST", headers: admin, body: JSON.stringify({ day: DAY, title: "Avec média", project, network: "x", status: "scheduled" }) })).json();

    const up = await fetch(`${s.base}/api/publications/${publication.id}/media?name=photo.jpg`, { method: "POST", headers: { Cookie: cookie, "content-type": "image/jpeg" }, body: jpeg() });
    assert.equal(up.status, 201, await up.clone().text());
    const media = await up.json();
    assert.equal(media.mime, "image/jpeg");

    const list = await (await fetch(`${s.base}/api/publications/${publication.id}/media`, { headers: admin })).json();
    assert.equal(list.length, 1);
    const read = await fetch(`${s.base}/api/media/${media.id}`, { headers: { Cookie: cookie } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("content-type"), "image/jpeg");
    assert.equal(read.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), jpeg());

    // Type déclaré mais signature inconnue : refusé.
    const fake = await fetch(`${s.base}/api/publications/${publication.id}/media?name=faux.jpg`, { method: "POST", headers: { Cookie: cookie, "content-type": "image/jpeg" }, body: Buffer.from("pas une image") });
    assert.equal(fake.status, 400, "signature vérifiée, pas l'extension");
    const anon = await fetch(`${s.base}/api/media/${media.id}`);
    assert.equal(anon.status, 401, "lecture admin seule");

    // Instagram : une image PNG est refusée avant l'envoi.
    const account = await (await fetch(`${s.base}/api/pub-accounts`, { method: "POST", headers: admin, body: JSON.stringify({ project, network: "instagram", label: "IG test" }) })).json();
    const ig = await (await fetch(`${s.base}/api/publications`, { method: "POST", headers: admin, body: JSON.stringify({ day: DAY, title: "IG", project, network: "instagram", status: "scheduled" }) })).json();
    await fetch(`${s.base}/api/publications/${ig.id}/media?name=image.png`, { method: "POST", headers: { Cookie: cookie, "content-type": "image/png" }, body: png() });
    const queued = await fetch(`${s.base}/api/publications/${ig.id}/queue`, { method: "POST", headers: admin, body: JSON.stringify({ now: true, text: "Bonjour", account_id: account.id }) });
    assert.equal(queued.status, 400);
    assert.match((await queued.json()).error, /Instagram : images JPEG uniquement/);

    assert.equal((await fetch(`${s.base}/api/publications/${publication.id}/media/${media.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status, 200);
    assert.deepEqual(await (await fetch(`${s.base}/api/publications/${publication.id}/media`, { headers: admin })).json(), []);
  } finally { s.stop(); t.done(); }
});
