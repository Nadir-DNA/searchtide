// B1-D1/D2 : filtre réseau — formes d'adresses, proxy filtrant sur Chromium réel (redirections, DNS, sous-ressources), cas positif.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { assertAllowedUrl, withPage } from "./pool.ts";
import { isForbiddenIp, isForbiddenName, startFilterProxy } from "./netguard.ts";

const FORBIDDEN_URLS = [
  "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[0:0:0:0:0:ffff:7f00:1]/", "http://[::ffff:a9fe:a9fe]/",
  "http://localhost./", "http://x.localhost/", "http://localhost/", "http://[fd00::1]/", "http://[fe80::1]/", "http://100.64.0.1/", "http://198.18.0.1/",
  "http://192.0.0.192/", "http://10.0.0.5/", "http://192.168.1.2/", "http://172.20.0.1/", "http://169.254.169.254/latest/meta-data", "http://metadata/",
  "http://instance-data/", "http://intranet/", "http://metadata.google.internal/", "http://nas.local/", "http://box.lan/", "http://x.home.arpa/", "http://x.internal./",
  "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://0.0.0.0/", "http://224.0.0.1/", "http://[64:ff9b::7f00:1]/",
];
test("B1-D1 : toutes les formes d'adresses internes sont refusées, les noms publics restent permis", () => {
  for (const u of FORBIDDEN_URLS) assert.throws(() => assertAllowedUrl(u, { sandbox: true, fixturePort: 4100 }), /refusée/, u);
  for (const u of ["https://exemple.com/", "http://8.8.8.8/", "https://[2606:4700:4700::1111]/", "http://blog.exemple.fr:8080/x"]) assert.doesNotThrow(() => assertAllowedUrl(u, { sandbox: true, fixturePort: 4100 }), u);
  assert.equal(isForbiddenIp("93.184.216.34"), false);
  assert.equal(isForbiddenName("exemple.com."), false);
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  const s: Server = createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, port: (s.address() as any).port as number };
}

test("B1-D2 : proxy filtrant sur Chromium réel — redirections, DNS, sous-ressources refusés ; page de recette atteignable", async () => {
  const hits: string[] = [];
  const secret = await listen((q, r) => { hits.push(q.url!); r.writeHead(200, { "content-type": "text/html" }); r.end("SECRET"); });
  const fixt = await listen((q, r) => {
    const p = q.url!.split("?")[0], to = decodeURIComponent(q.url!.split("to=")[1] ?? "");
    if (p === "/redir") { r.writeHead(302, { location: to }); r.end(); return; }
    if (p === "/img") { r.writeHead(200, { "content-type": "text/html" }); r.end(`<img src="${to}"><script src="${to}"></script>ok`); return; }
    r.writeHead(200, { "content-type": "text/html" }); r.end("<h1>page de recette</h1>");
  });
  const F = `http://127.0.0.1:${fixt.port}`, S = secret.port;
  // DNS simulé : tous ces noms « publics » résolvent vers une adresse interne ; le dernier alterne (rebinding).
  const table: Record<string, string[]> = { "public-looking.test": ["127.0.0.1"], "to-metadata.test": ["169.254.169.254"], "to-ten.test": ["10.0.0.1"], "mixed.test": ["1.1.1.1", "127.0.0.1"] };
  const lookup = async (h: string) => table[h] ?? [];
  const to = (u: string) => encodeURIComponent(u);
  const cases: [string, string][] = [
    ["302 vers 127.0.0.1", `${F}/redir?to=${to(`http://127.0.0.1:${S}/s`)}`],
    ["302 vers [::ffff:127.0.0.1]", `${F}/redir?to=${to(`http://[::ffff:127.0.0.1]:${S}/s`)}`],
    ["302 vers [::ffff:a9fe:a9fe]", `${F}/redir?to=${to(`http://[::ffff:a9fe:a9fe]:${S}/s`)}`],
    ["302 vers nom → 127.0.0.1", `${F}/redir?to=${to(`http://public-looking.test:${S}/s`)}`],
    ["302 vers nom → 169.254.169.254", `${F}/redir?to=${to(`http://to-metadata.test:${S}/s`)}`],
    ["302 vers nom → 10.0.0.1", `${F}/redir?to=${to(`http://to-ten.test:${S}/s`)}`],
    ["302 vers nom à adresses mixtes", `${F}/redir?to=${to(`http://mixed.test:${S}/s`)}`],
    ["sous-ressources image et script", `${F}/img?to=${to(`http://[::ffff:7f00:1]:${S}/s`)}`],
    ["saisie directe [::ffff:127.0.0.1]", `http://[::ffff:127.0.0.1]:${S}/s`],
    ["saisie directe nom → 127.0.0.1", `http://public-looking.test:${S}/s`],
  ];
  try {
    for (const [label, url] of cases) {
      const before = hits.length;
      await withPage(url, async (page) => { await page.waitForTimeout(500); return page.content(); }, { fixturePort: fixt.port, sandbox: true, chromiumSandbox: false, timeoutMs: 8000, lookup }).catch(() => {});
      assert.equal(hits.length, before, `${label} : le serveur interne a été atteint (${hits.slice(before).join(",")})`);
    }
    // Cas positif : la page de recette déclarée (port prévu) reste atteignable, preuve que tout n'est pas bloqué.
    const title = await withPage(`${F}/ok`, async (page) => page.locator("h1").innerText(), { fixturePort: fixt.port, sandbox: true, chromiumSandbox: false, timeoutMs: 15_000, lookup });
    assert.equal(title, "page de recette");
  } finally { secret.s.close(); fixt.s.close(); }
});

test("B1-D2 : le proxy exige son identifiant et refuse une adresse interne, même après une première résolution publique", async () => {
  let calls = 0;
  const p = await startFilterProxy({ sandbox: true, lookup: async () => (++calls === 1 ? ["10.0.0.1"] : ["127.0.0.1"]) });
  const via = (target: string, auth: boolean) => new Promise<number>((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port: p.port, path: target, headers: { host: new URL(target).host, ...(auth ? { "proxy-authorization": "Basic " + Buffer.from(`${p.auth.username}:${p.auth.password}`).toString("base64") } : {}) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("error", reject); r.end();
  });
  try {
    assert.equal(await via("http://exemple.test/", false), 407, "sans identifiant");
    assert.equal(await via("http://exemple.test/", true), 403, "1re résolution interne");
    assert.equal(await via("http://exemple.test/", true), 403, "2e résolution interne (rebinding)");
    assert.equal(p.stats.allowed, 0);
    assert.equal(p.stats.refused, 2);
  } finally { await p.close(); }
});
