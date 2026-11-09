// Rapport hebdomadaire : visites, Google, CRM et publications de la semaine écoulée, envoyé le lundi matin.
import type { Hono } from "hono";
import { mailSetup } from "./connectors/channels.ts";
import { db, localDay } from "./db.ts";
import { previous, searchStats, strikingDistance, trafficStats, type Range } from "./stats.ts";
import { listProjects } from "./projects.ts";

type Row = Record<string, any>;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const TZ = process.env.REPORT_TZ ?? "Europe/Paris";

/** Semaine complète (lundi → dimanche) qui précède `now`. */
export function lastWeek(now = new Date()): Range {
  const d = new Date(localDay(now) + "T00:00:00Z");
  const monday = d.getTime() - (((d.getUTCDay() + 6) % 7) + 7) * 86400000;
  return { from: day(monday), to: day(monday + 6 * 86400000) };
}

export function weeklyReport(week = lastWeek()) {
  const sites = (db.prepare("SELECT id, domain, gsc_property FROM sites ORDER BY domain").all() as Row[]).map((s) => {
    const t = trafficStats(s.id, week);
    // Google publie avec 2 à 3 jours de retard : on prend les 7 derniers jours publiés pour comparer à armes égales
    const lastGsc = (db.prepare("SELECT MAX(day) AS d FROM gsc_rows WHERE site_id = ? AND query = '' AND page = '' AND day <= ?").get(s.id, week.to) as Row).d as string | null;
    const gscRange = lastGsc ? { from: day(Date.parse(lastGsc) - 6 * 86400000), to: lastGsc } : null;
    const g = s.gsc_property && gscRange ? searchStats(s.id, gscRange, 5) : null;
    return {
      domain: s.domain,
      visitors: t.totals.visitors as number, prevVisitors: t.previous.visitors as number, pageviews: t.totals.pageviews as number, ai: t.totals.ai as number,
      topPages: t.pages.slice(0, 3).map((p) => p.key as string),
      channels: t.channels.slice(0, 3).map((c) => ({ key: c.key as string, visitors: c.visitors as number })),
      search: g && {
        range: gscRange!, clicks: g.totals.clicks as number, prevClicks: g.previous.clicks as number,
        impressions: g.totals.impressions as number, prevImpressions: g.previous.impressions as number,
        position: g.totals.position as number | null, prevPosition: g.previous.position as number | null,
        queries: g.queries.slice(0, 3).map((q) => ({ query: q.query as string, clicks: q.clicks as number, impressions: q.impressions as number })),
        opportunities: strikingDistance(s.id, { from: day(Date.parse(gscRange!.to) - 27 * 86400000), to: gscRange!.to }, 3)
          .map((q) => ({ query: q.query as string, impressions: q.impressions as number, position: q.position as number })),
      },
    };
  });
  const from = Date.parse(week.from), to = Date.parse(week.to) + 86400000;
  const one = (sql: string, ...a: (string | number)[]) => (Object.values(db.prepare(sql).get(...a) as Row)[0] ?? 0) as number;
  const crm = {
    newContacts: one("SELECT COUNT(*) FROM contacts WHERE created_at >= ? AND created_at < ?", from, to),
    touches: one("SELECT COUNT(*) FROM activities WHERE kind IN ('email', 'sms', 'call') AND ts >= ? AND ts < ?", from, to),
    moves: db.prepare(`SELECT substr(text, instr(text, '→ ') + 4) AS stage, COUNT(*) AS n FROM activities
      WHERE kind = 'stage' AND ts >= ? AND ts < ? GROUP BY 1`).all(from, to) as { stage: string; n: number }[],
    won: db.prepare(`SELECT c.name, c.company, c.value FROM contacts c WHERE EXISTS (SELECT 1 FROM activities a
      WHERE a.contact_id = c.id AND a.kind = 'stage' AND a.text LIKE '%→ won' AND a.ts >= ? AND a.ts < ?)`).all(from, to) as Row[],
    todo: one("SELECT COUNT(*) FROM contacts WHERE next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')", localDay()),
  };
  const next = { from: day(to), to: day(to + 6 * 86400000) };
  const pubs = {
    published: db.prepare("SELECT day, title, project, network, url FROM publications WHERE status = 'published' AND day BETWEEN ? AND ? ORDER BY day").all(week.from, week.to) as Row[],
    missed: db.prepare("SELECT day, title, project, network FROM publications WHERE status = 'scheduled' AND day BETWEEN ? AND ? ORDER BY day").all(week.from, week.to) as Row[],
    next: db.prepare("SELECT day, title, project, network, status FROM publications WHERE status <> 'published' AND day BETWEEN ? AND ? ORDER BY day").all(next.from, next.to) as Row[],
  };
  const sum = (f: (s: (typeof sites)[number]) => number) => sites.reduce((n, s) => n + f(s), 0);
  const projects = listProjects(week).map((p) => ({ name: p.name as string, color: p.color as string | null,
    indicators: (p.indicators as Row[]).map((i) => ({ label: i.label as string, unit: i.unit as string | null, mode: i.mode as string, value: i.value as number | null, previous: i.previous as number | null, error: i.last_error as string | null })) }));
  return {
    week, previous: previous(week), sites, crm, pubs, projects,
    totals: { visitors: sum((s) => s.visitors), prevVisitors: sum((s) => s.prevVisitors), clicks: sum((s) => s.search?.clicks ?? 0), prevClicks: sum((s) => s.search?.prevClicks ?? 0) },
  };
}
export type Report = ReturnType<typeof weeklyReport>;

// ── Mise en page e-mail (styles en ligne, tableaux : seul format fiable dans les messageries) ──
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const n = (v: number | null | undefined, d = 0) => v == null ? "—" : v.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });
const dFr = (d: string, o: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { ...o, timeZone: "UTC" });
const unitVal = (v: number | null, unit: string | null) => v == null ? "—" : `${n(v, v % 1 ? 2 : 0)}${unit ? ` ${unit}` : ""}`;
/** « 1 visiteur », « 3 visiteurs » */
const pl = (v: number, one: string, many = one + "s") => `${n(v)} ${Math.abs(v) >= 2 ? many : one}`;
const STAGE: Record<string, string> = { new: "nouveaux", contacted: "contactés", qualified: "intéressés", proposal: "en proposition", won: "gagnés", lost: "perdus" };
const CH: Record<string, string> = { direct: "accès direct", search: "moteurs de recherche", social: "réseaux sociaux", ai: "assistants IA", referral: "autres sites", email: "e-mail", paid: "publicité" };

/** Évolution lisible : « +25 % », « nouveau », « = ». */
export function evo(now: number | null, before: number | null, lowerIsBetter = false) {
  if (now == null || before == null || (!now && !before)) return { text: "", tone: "" };
  if (!before) return { text: "nouveau", tone: "up" };
  const change = lowerIsBetter ? before - now : ((now - before) / before) * 100;
  if (Math.abs(change) < 0.05) return { text: "=", tone: "" };
  const text = lowerIsBetter ? `${change > 0 ? "+" : "−"}${n(Math.abs(change), 1)} place${Math.abs(change) >= 2 ? "s" : ""}` : `${change > 0 ? "+" : "−"}${n(Math.abs(change))} %`;
  return { text, tone: change > 0 ? "up" : "down" };
}
const pill = (e: { text: string; tone: string }) => e.text
  ? `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:12px;background:${e.tone === "up" ? "#dcfae5" : e.tone === "down" ? "#ffe9e6" : "#eef0f2"};color:${e.tone === "up" ? "#1e7b4f" : e.tone === "down" ? "#b4232a" : "#5b6267"}">${esc(e.text)}</span>` : "";

export function reportHtml(r: Report, base = "") {
  const h2 = (t: string) => `<h2 style="font-size:17px;font-weight:600;margin:28px 0 10px">${t}</h2>`;
  const kpi = (label: string, value: string, e: { text: string; tone: string }) =>
    `<td style="padding:14px;border:1px solid #e1e5e8;border-radius:12px;width:50%;vertical-align:top"><div style="font-size:12px;color:#5b6267">${label}</div><div style="font-size:24px;margin-top:4px">${value} ${pill(e)}</div></td>`;
  const li = (items: string[], empty: string) => items.length ? `<ul style="margin:6px 0;padding-left:18px">${items.map((i) => `<li style="margin:3px 0">${i}</li>`).join("")}</ul>` : `<p style="color:#5b6267;margin:6px 0">${empty}</p>`;
  const sites = r.sites.map((s) => `
    <tr><td style="padding:16px 0;border-top:1px solid #e1e5e8">
      <div style="font-size:15px;font-weight:600">${esc(s.domain)}</div>
      <div style="margin-top:4px">${pl(s.visitors, "visite")} ${pill(evo(s.visitors, s.prevVisitors))} · ${pl(s.pageviews, "page vue", "pages vues")}${s.ai ? ` · ${n(s.ai)} depuis les IA` : ""}</div>
      ${s.channels.length ? `<div style="color:#5b6267;font-size:13px;margin-top:2px">Provenance : ${s.channels.map((c) => `${esc(CH[c.key] ?? c.key)} (${n(c.visitors)})`).join(", ")}</div>` : ""}
      ${s.topPages.length ? `<div style="color:#5b6267;font-size:13px">Pages les plus vues : ${s.topPages.map(esc).join(", ")}</div>` : ""}
      ${s.search ? `<div style="margin-top:8px">Google (${dFr(s.search.range.from, { day: "numeric", month: "short" })} → ${dFr(s.search.range.to, { day: "numeric", month: "short" })}) : ${pl(s.search.clicks, "clic")} ${pill(evo(s.search.clicks, s.search.prevClicks))} · ${pl(s.search.impressions, "impression")} ${pill(evo(s.search.impressions, s.search.prevImpressions))} · position ${n(s.search.position, 1)} ${pill(evo(s.search.position, s.search.prevPosition, true))}</div>
        ${s.search.queries.length ? `<div style="color:#5b6267;font-size:13px;margin-top:2px">Mots-clés : ${s.search.queries.map((q) => `${esc(q.query)} (${n(q.impressions)} impr.)`).join(", ")}</div>` : ""}
        ${s.search.opportunities.length ? `<div style="font-size:13px;margin-top:2px">À travailler : ${s.search.opportunities.map((q) => `<b>${esc(q.query)}</b> (position ${n(q.position, 1)})`).join(", ")}</div>` : ""}` : ""}
    </td></tr>`).join("");
  const pub = (p: Row) => `${dFr(p.day, { weekday: "short", day: "numeric" })} · ${p.url ? `<a href="${esc(p.url)}" style="color:#111315">${esc(p.title)}</a>` : esc(p.title)}${p.network || p.project ? ` <span style="color:#5b6267">(${esc([p.project, p.network].filter(Boolean).join(" · "))})</span>` : ""}`;
  const moves = r.crm.moves.filter((m) => m.stage !== "new").map((m) => `${n(m.n)} ${STAGE[m.stage] ?? m.stage}`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Rapport de la semaine</title></head>
<body style="margin:0;background:#edf0f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111315;font-size:14px;line-height:1.5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:16px"><tr><td style="padding:28px">
  <div style="font-size:13px;color:#5b6267">Semaine du ${dFr(r.week.from)} au ${dFr(r.week.to)}</div>
  <h1 style="font-size:24px;font-weight:400;margin:4px 0 18px">Rapport de la semaine</h1>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="margin:0 -8px"><tr>
    ${kpi("Visites, tous sites", n(r.totals.visitors), evo(r.totals.visitors, r.totals.prevVisitors))}
    ${kpi("Clics Google", n(r.totals.clicks), evo(r.totals.clicks, r.totals.prevClicks))}
  </tr><tr>
    ${kpi("Relances à faire", n(r.crm.todo), { text: "", tone: "" })}
    ${kpi("Échanges avec des contacts", n(r.crm.touches), { text: "", tone: "" })}
  </tr></table>
  ${r.projects.length ? h2("Projets") + r.projects.map((p) => `
    <div style="margin:14px 0 6px;font-size:15px;font-weight:600"><span style="display:inline-block;width:9px;height:9px;border-radius:5px;background:${esc(p.color ?? "#a3e635")};margin-right:7px"></span>${esc(p.name)}</div>
    ${p.indicators.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${p.indicators.map((i) => `<tr><td style="padding:4px 0;color:#5b6267">${esc(i.label)}${i.mode === "total" ? "" : " (semaine)"}</td><td align="right" style="padding:4px 0">${i.error ? `<span style="color:#b4232a">relevé en erreur</span>` : `${esc(unitVal(i.value, i.unit))} ${pill(evo(i.value, i.previous))}`}</td></tr>`).join("")}</table>` : `<p style="color:#5b6267;margin:4px 0">Aucun indicateur.</p>`}`).join("") : ""}
  ${h2("Sites")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${sites}</table>
  ${h2("Contacts")}
  ${li([
    `${n(r.crm.newContacts)} nouveau${r.crm.newContacts > 1 ? "x" : ""} contact${r.crm.newContacts > 1 ? "s" : ""}`,
    ...(moves.length ? [`Changements d'étape : ${moves.join(", ")}`] : []),
    ...r.crm.won.map((w) => `Gagné : <b>${esc(w.company || w.name)}</b>${w.value ? ` (${n(w.value)} €)` : ""}`),
    `${n(r.crm.todo)} relance${r.crm.todo > 1 ? "s" : ""} à faire aujourd'hui ou en retard`,
  ], "")}
  ${h2("Publications")}
  <div style="font-size:13px;color:#5b6267">Publiées cette semaine</div>${li(r.pubs.published.map(pub), "Aucune publication marquée comme publiée.")}
  ${r.pubs.missed.length ? `<div style="font-size:13px;color:#b4232a;margin-top:10px">Prévues mais pas marquées publiées</div>${li(r.pubs.missed.map(pub), "")}` : ""}
  <div style="font-size:13px;color:#5b6267;margin-top:10px">Semaine prochaine</div>${li(r.pubs.next.map(pub), "Rien de prévu : pensez à remplir le calendrier.")}
  ${base ? `<p style="margin-top:28px"><a href="${esc(base)}" style="display:inline-block;background:#a3e635;color:#111315;text-decoration:none;padding:9px 16px;border-radius:20px;font-weight:600">Ouvrir le tableau de bord</a></p>` : ""}
  <p style="font-size:12px;color:#5b6267;margin-top:24px">Google publie ses données avec 2 à 3 jours de retard : la partie Google couvre les 7 derniers jours publiés, comparés aux 7 jours d'avant.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function reportText(r: Report) {
  const lines = [`Rapport de la semaine du ${dFr(r.week.from)} au ${dFr(r.week.to)}`, "",
    `Visites, tous sites : ${n(r.totals.visitors)} ${evo(r.totals.visitors, r.totals.prevVisitors).text}`,
    `Clics Google : ${n(r.totals.clicks)} ${evo(r.totals.clicks, r.totals.prevClicks).text}`, ""];
  for (const s of r.sites) {
    lines.push(`${s.domain} : ${pl(s.visitors, "visite")} ${evo(s.visitors, s.prevVisitors).text}`);
    if (s.search) lines.push(`  Google : ${n(s.search.clicks)} clics, ${n(s.search.impressions)} impressions, position ${n(s.search.position, 1)}`);
  }
  for (const p of r.projects) lines.push("", p.name, ...p.indicators.map((i) => `  ${i.label} : ${i.error ? "relevé en erreur" : unitVal(i.value, i.unit)} ${evo(i.value, i.previous).text}`));
  lines.push("", `Contacts : ${n(r.crm.newContacts)} nouveaux, ${n(r.crm.touches)} échanges, ${n(r.crm.todo)} relances à faire`);
  lines.push(`Publications : ${r.pubs.published.length} publiées, ${r.pubs.next.length} prévues la semaine prochaine`);
  return lines.join("\n");
}

// ── Envoi ──
export const mailConfigured = () => { const m = mailSetup(); return !!(m && m.to); };

export async function sendReport(r = weeklyReport()) {
  const m = mailSetup();
  if (!m || !m.to) throw new Error("Envoi non configuré : ajoutez E-mail (SMTP) dans Connexions");
  await m.transport.sendMail({
    from: m.from,
    to: m.to,
    subject: `Rapport de la semaine : ${pl(r.totals.visitors, "visite")}, ${pl(r.totals.clicks, "clic")} Google`,
    text: reportText(r),
    html: reportHtml(r, process.env.PUBLIC_URL ?? ""),
  });
  db.prepare("INSERT INTO settings (key, value) VALUES ('report_sent_week', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(r.week.from);
}

db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");

/** Heure et jour locaux (fuseau du rapport), pour déclencher l'envoi le lundi à 8 h. */
function localNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) };
}
export function dueNow(now = new Date()) {
  const { weekday, hour } = localNow(now);
  const sent = (db.prepare("SELECT value FROM settings WHERE key = 'report_sent_week'").get() as Row | undefined)?.value;
  return weekday === "Mon" && hour >= 8 && sent !== lastWeek(now).from;
}

export function registerReport(app: Hono) {
  app.get("/api/report", (c) => c.json({ ...weeklyReport(), mail: mailConfigured() }));
  app.get("/api/report.html", (c) => c.html(reportHtml(weeklyReport(), new URL(c.req.url).origin)));
  app.post("/api/report/send", async (c) => {
    try { await sendReport(); return c.json({ ok: true, to: mailSetup()?.to }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  // Vérifie toutes les 30 min ; un envoi par semaine au plus
  setInterval(() => { if (mailConfigured() && dueNow()) sendReport().catch((e) => console.error("[rapport]", e.message)); }, 30 * 60 * 1000).unref();
}
