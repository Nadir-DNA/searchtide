// Tests T12 : connecteurs SMTP (préréglage Gmail) et ntfy, et leur branchement sur le rapport, les alertes et la prospection.
// Serveur SMTP et serveur ntfy SIMULÉS : aucun e-mail ni notification réels n'est envoyé.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db.ts";
import { markAdmin } from "../admin.ts";
import { connections } from "../connections.ts";
import { registerConnections, setConnectorContext } from "./api.ts";
import { setCollectContext } from "./use.ts";
import { mailSetup, ntfySetup } from "./channels.ts";
import { get, realCtx } from "./registry.ts";
import { checkContract } from "./contract.ts";
import { FIXTURES } from "./fixtures.ts";
import { sendReport, mailConfigured } from "../report.ts";
import { sendToContact } from "../outreach.ts";
import { createContact } from "../business.ts";
import { notify } from "../ops.ts";
import type { SmtpOptions } from "./types.ts";
import "./index.ts";

process.env.SECRET = "t".repeat(40);
const PASS = "wxyzabcdwxyzabcd";
const TOPIC = "searchtide-9f8e7d6c5b4a39281706";
type Mail = Record<string, any>;
const mails: Mail[] = []; const opts: SmtpOptions[] = []; const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
let smtpError: any = null; let ntfyStatus = 200;

const sim = realCtx({
  smtp: (o) => { opts.push(o); return { verify: async () => { if (smtpError) throw smtpError; return true; }, sendMail: async (m: Mail) => { mails.push(m); return {}; } }; },
  fetch: (async (u: any, i: RequestInit = {}) => { posts.push({ url: String(u), headers: (i.headers ?? {}) as Record<string, string>, body: i.body ? JSON.parse(String(i.body)) : null }); return new Response("{}", { status: ntfyStatus }); }) as typeof fetch,
});
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin);
const post = (body: unknown) => admin.request("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const GMAIL = { kind: "smtp", values: { preset: "gmail", user: "moi@exemple.com", pass: PASS, to: "rapport@exemple.com" } };
const NTFY = { kind: "ntfy", values: { topic: TOPIC } };
beforeEach(() => { mails.length = 0; opts.length = 0; posts.length = 0; smtpError = null; ntfyStatus = 200; delete process.env.SMTP_URL; delete process.env.NTFY_TOPIC; delete process.env.REPORT_TO; delete process.env.REPORT_FROM; process.env.SECRET = "t".repeat(40); db.exec("DELETE FROM connections"); setConnectorContext(sim); setCollectContext(sim); });

test("contrat commun : SMTP et ntfy sont conformes", async () => {
  for (const id of ["smtp", "ntfy"]) assert.deepEqual(await checkContract(get(id)!, FIXTURES[id]), [], id);
});

test("SMTP, préréglage Gmail : smtp.gmail.com:465 en SSL, e-mail d'essai envoyé, mot de passe jamais renvoyé", async () => {
  const r = await post(GMAIL); const text = await r.text();
  assert.equal(r.status, 201, text);
  assert.doesNotMatch(text, new RegExp(PASS.slice(0, 8)));
  assert.deepEqual([opts[0].host, opts[0].port, opts[0].secure], ["smtp.gmail.com", 465, true]);
  assert.deepEqual(opts[0].auth, { user: "moi@exemple.com", pass: PASS });
  assert.equal(mails.length, 1); assert.equal(mails[0].to, "rapport@exemple.com"); assert.equal(mails[0].from, "moi@exemple.com");
  const j = JSON.parse(text);
  assert.equal(j.test.detail, "E-mail d'essai envoyé à rapport@exemple.com"); assert.equal(j.connection.hint, "moi@exemple.com · smtp.gmail.com");
  assert.equal((await post({ ...GMAIL, values: { ...GMAIL.values, pass: "autre-mot-de-passe-0001" } })).status, 409, "un seul compte e-mail");
});

test("SMTP : serveur personnalisé (587, STARTTLS), hôte obligatoire hors Gmail", async () => {
  const bad = await post({ kind: "smtp", values: { preset: "other", user: "a@exemple.com", pass: PASS } });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "Indiquez le serveur SMTP (ou choisissez Gmail).");
  const ok = await post({ kind: "smtp", values: { preset: "other", host: "smtp.exemple.net", port: "587", security: "starttls", user: "a@exemple.com", pass: PASS } });
  assert.equal(ok.status, 201);
  assert.deepEqual([opts.at(-1)!.host, opts.at(-1)!.port, opts.at(-1)!.secure, opts.at(-1)!.requireTLS], ["smtp.exemple.net", 587, false, true]);
});

test("SMTP refusé : message Gmail clair, serveur injoignable, délai — aucune ligne créée", async () => {
  smtpError = Object.assign(new Error("Invalid login: 535 5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });
  let r = await post(GMAIL);
  assert.equal((await r.json()).error, "Identifiant ou mot de passe refusé. Avec Gmail, utilisez un mot de passe d'application, pas votre mot de passe.");
  smtpError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  r = await post(GMAIL); assert.match((await r.json()).error, /Connexion impossible à smtp\.gmail\.com:465/);
  smtpError = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
  r = await post(GMAIL); assert.equal((await r.json()).error, "Le serveur SMTP ne répond pas. Réessayez dans un instant.");
  assert.equal(connections().length, 0); assert.equal(mails.length, 0);
});

test("ntfy : sujet validé, notification d'essai publiée avec le jeton, sujet jamais renvoyé", async () => {
  const bad = await post({ kind: "ntfy", values: { topic: "sujet avec espaces!" } });
  assert.match((await bad.json()).error, /lettres, chiffres, tiret/);
  const r = await post({ kind: "ntfy", values: { topic: TOPIC, server: "https://ntfy.exemple.test", token: "tk_JETONsecret0123456789" } });
  const text = await r.text();
  assert.equal(r.status, 201, text); assert.doesNotMatch(text, new RegExp(TOPIC.slice(-10))); assert.doesNotMatch(text, /JETONsecret/);
  assert.equal(JSON.parse(text).connection.hint, "ntfy.exemple.test · sujet masqué");
  assert.equal(posts[0].url, "https://ntfy.exemple.test/"); assert.equal(posts[0].body.topic, TOPIC);
  assert.equal(posts[0].headers.Authorization, "Bearer tk_JETONsecret0123456789");
  assert.equal((await post(NTFY)).status, 409, "un seul compte ntfy");
});

test("ntfy : accès refusé (401) ou serveur invalide → rien d'enregistré", async () => {
  ntfyStatus = 401;
  assert.match((await (await post(NTFY)).json()).error, /ntfy refuse l'accès/);
  ntfyStatus = 200;
  assert.match((await (await post({ kind: "ntfy", values: { topic: TOPIC, server: "ftp://exemple" } })).json()).error, /https:\/\//);
  assert.equal(connections().length, 0);
});

test("rapport hebdo, alertes et prospection passent par les connexions (et non par .env)", async () => {
  assert.equal(mailSetup(), null); assert.equal(ntfySetup(), null); assert.equal(mailConfigured(), false);
  await assert.rejects(sendReport(), /Connexions/);
  await post(GMAIL); await post(NTFY); mails.length = 0; posts.length = 0;
  assert.equal(mailConfigured(), true); assert.equal(mailSetup()!.via, "connexion");
  await sendReport();
  assert.equal(mails.length, 1); assert.equal(mails[0].to, "rapport@exemple.com"); assert.match(mails[0].subject, /Rapport de la semaine/);
  const c = createContact({ name: "Paul", email: "paul@exemple.fr" }) as any;
  await sendToContact(c.id, "Bonjour {{prenom}}", "Message");
  assert.equal(mails.at(-1)!.to, "paul@exemple.fr"); assert.equal(mails.at(-1)!.from, "moi@exemple.com");
  mails.length = 0;
  await notify("Site hors ligne", "exemple.com ne répond plus", "high");
  assert.equal(posts[0].body.title, "Site hors ligne"); assert.equal(posts[0].body.priority, 5); assert.equal(posts[0].body.topic, TOPIC);
  assert.equal(mails.length, 1, "alerte importante : aussi par e-mail"); assert.match(mails[0].subject, /\[Searchtide\]/);
  posts.length = 0; mails.length = 0;
  await notify("Info", "rien d'urgent");
  assert.equal(posts.length, 1); assert.equal(mails.length, 0, "alerte normale : ntfy seulement");
});

test("SECRET changé : les canaux deviennent indisponibles sans exception, la variable d'environnement prend le relais", async () => {
  await post(GMAIL); await post(NTFY);
  process.env.SECRET = "z".repeat(40);
  assert.equal(mailSetup(), null); assert.equal(ntfySetup(), null);
  await assert.doesNotReject(notify("x", "y", "high"));
  process.env.SMTP_URL = "smtp://u:p@smtp.exemple.net:587"; process.env.REPORT_TO = "moi@exemple.com"; process.env.NTFY_TOPIC = "ancien-sujet";
  assert.equal(mailSetup()!.via, "env"); assert.equal(ntfySetup()!.via, "env");
});

test("une connexion de l'interface l'emporte sur la variable d'environnement", async () => {
  process.env.SMTP_URL = "smtp://u:p@smtp.exemple.net:587"; process.env.NTFY_TOPIC = "sujet-env";
  await post(GMAIL); await post(NTFY);
  assert.equal(mailSetup()!.via, "connexion"); assert.equal(ntfySetup()!.via, "connexion");
});
