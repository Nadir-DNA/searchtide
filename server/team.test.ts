// A10 : équipe — comptes nominatifs, admin = tous les droits, membre = lecture seule, déconnexion et réinitialisation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb } from "./test-server.ts";

const cookieOf = (r: Response) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

test("équipe : création par le propriétaire, connexion par adresse, droits selon le rôle", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const owner = await login(s.base);
    const post = (cookie: string, path: string, body: unknown, method = "POST") => fetch(`${s.base}${path}`, { method, headers: { "content-type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
    const m = await (await post(owner, "/api/team", { email: "Lea@Exemple.fr", name: "Léa", role: "membre" })).json();
    assert.equal(m.email, "lea@exemple.fr"); assert.match(m.password, /^[\w]{5}(-[\w]{5}){3}$/);
    const a = await (await post(owner, "/api/team", { email: "max@exemple.fr", role: "admin" })).json();
    assert.equal((await post(owner, "/api/team", { email: "lea@exemple.fr" })).status, 400, "adresse déjà prise");

    const bad = await post("", "/api/login", { email: "lea@exemple.fr", password: "faux" });
    assert.equal(bad.status, 401);
    const lea = cookieOf(await post("", "/api/login", { email: "lea@exemple.fr", password: m.password }));
    const me = await (await fetch(`${s.base}/api/me`, { headers: { Cookie: lea } })).json();
    assert.deepEqual([me.role, me.name], ["membre", "Léa"]);
    assert.equal((await fetch(`${s.base}/api/projects`, { headers: { Cookie: lea } })).status, 200, "le membre lit les projets");
    assert.equal((await post(lea, "/api/projects", { name: "Interdit" })).status, 403, "mais n'écrit pas");
    assert.equal((await fetch(`${s.base}/api/team`, { headers: { Cookie: lea } })).status, 403);
    assert.equal((await fetch(`${s.base}/api/connections`, { headers: { Cookie: lea } })).status, 403);

    const max = cookieOf(await post("", "/api/login", { email: "max@exemple.fr", password: a.password }));
    assert.equal((await post(max, "/api/projects", { name: "Projet de Max" })).status, 201, "l'admin écrit");
    assert.equal((await fetch(`${s.base}/api/team`, { headers: { Cookie: max } })).status, 200);

    // Changer le rôle déconnecte ; le nouveau mot de passe remplace l'ancien.
    await post(owner, `/api/team/${m.id}`, { role: "admin" }, "PATCH");
    assert.equal((await fetch(`${s.base}/api/projects`, { headers: { Cookie: lea } })).status, 401);
    const reset = await (await post(owner, `/api/team/${m.id}`, { resetPassword: true }, "PATCH")).json();
    assert.equal((await post("", "/api/login", { email: "lea@exemple.fr", password: m.password })).status, 401);
    assert.equal((await post("", "/api/login", { email: "lea@exemple.fr", password: reset.password })).status, 200);

    // Déconnexion d'un membre : son cookie ne vaut plus, la session du propriétaire reste ouverte.
    await post(max, "/api/logout", {});
    assert.equal((await fetch(`${s.base}/api/team`, { headers: { Cookie: max } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/team`, { headers: { Cookie: owner } })).status, 200);
  } finally { s.stop(); t.done(); }
});
