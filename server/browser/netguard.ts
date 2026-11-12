// B1 : filtre réseau du navigateur intégré. Deux couches :
//  1. `assertAllowedUrl` (pool.ts) refuse tôt, avec un message clair ; ce n'est PAS la protection.
//  2. Un proxy sortant local, seul chemin du Chromium lancé : il résout lui-même chaque nom, refuse toute adresse
//     interne (une seule suffit), et se connecte à l'adresse RÉSOLUE et validée (épinglage : plus de rebinding).
//     Chaque saut de redirection, sous-ressource et connexion CONNECT (HTTPS) repasse par lui.
// Limites : le proxy ne déchiffre pas le HTTPS ; en conteneur, interdire en plus la sortie vers les réseaux privés.
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { randomBytes } from "node:crypto";

type Lookup = (host: string) => Promise<string[]>;

/** IPv4 → entier de 32 bits ; null si ce n'est pas une IPv4 valide. */
const v4n = (ip: string) => { const p = ip.split("."); return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && +x < 256) ? p.reduce((a, x) => a * 256 + +x, 0) : null; };
const inV4 = (n: number, base: string, bits: number) => { const b = v4n(base)!; const m = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return ((n & m) >>> 0) === ((b & m) >>> 0); };
const FORBIDDEN_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Développe une IPv6 en 8 groupes de 16 bits (gère `::` et la fin en IPv4) ; null si invalide. */
function v6groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) { const n = v4n(tail[1]); if (n == null) return null; s = s.slice(0, -tail[1].length) + ((n >>> 16).toString(16)) + ":" + ((n & 0xffff).toString(16)); }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** Vrai si l'adresse (IPv4 ou IPv6, crochets admis) est interne, réservée ou invalide : tout refuser par défaut. */
export function isForbiddenIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, "");
  const kind = net.isIP(ip.split("%")[0]);
  if (kind === 4) { const n = v4n(ip)!; return FORBIDDEN_V4.some(([b, bits]) => inV4(n, b, bits)); }
  if (kind !== 6) return true;
  const g = v6groups(ip);
  if (!g) return true;
  const v4of = (hi: number, lo: number) => isForbiddenIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4of(g[6], g[7]);      // ::ffff:a.b.c.d (IPv4 mappée)
  if (g.slice(0, 6).every((x) => x === 0)) return true;                                    // ::, ::1 et IPv4 compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4of(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return v4of(g[1], g[2]);                                             // 6to4
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true; // ULA, lien local, multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true;                      // documentation, Teredo
  return false;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".intranet", ".corp", ".home"];
/** Nom refusé sans résolution : sans point (metadata, intranet), suffixes locaux ; le point final est ignoré. */
export function isForbiddenName(raw: string): boolean {
  const h = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(h.split("%")[0])) return isForbiddenIp(h);
  if (!h.includes(".")) return true;
  return LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

/** Le nom ou l'adresse tapé est-il une forme numérique exotique (0x7f.1, 2130706433…) que le navigateur lirait comme IPv4 ? */
export const exoticNumeric = (h: string) => /^[0-9a-fx.]+$/i.test(h) && !net.isIP(h);

export const defaultLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type Fixture = { port: number } | null;
export type FilterProxy = { port: number; auth: { username: string; password: string }; close: () => Promise<void>; stats: { allowed: number; refused: number } };

/**
 * Démarre le proxy filtrant. `fixture` : seule exception, la boucle locale sur le port des pages de test (mode recette).
 * `sandbox: false` limite en plus tout à cette exception.
 */
export async function startFilterProxy(o: { sandbox: boolean; fixture?: Fixture; lookup?: Lookup }): Promise<FilterProxy> {
  const lookup = o.lookup ?? defaultLookup;
  const auth = { username: "st", password: randomBytes(16).toString("hex") };
  const expected = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  const stats = { allowed: 0, refused: 0 };
  const sockets = new Set<net.Socket>();

  /** Adresse à joindre pour host:port, ou null (refus). Le choix de l'adresse est fait ici, une fois. */
  async function resolveTarget(host: string, port: number): Promise<string | null> {
    const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const fixtureHost = h === "127.0.0.1" || h === "localhost" || h === "::1";
    if (o.fixture && fixtureHost && port === o.fixture.port) return h === "localhost" ? "127.0.0.1" : h;
    if (!o.sandbox) return null;
    if (exoticNumeric(h) || isForbiddenName(h)) return null;
    const addrs = net.isIP(h) ? [h] : await lookup(h).catch(() => []);
    if (!addrs.length || addrs.some(isForbiddenIp)) return null;
    return addrs[0];
  }
  const refuse = (sock: net.Socket | http.ServerResponse, code = 403) => {
    stats.refused += 1;
    if ("writeHead" in sock) { sock.writeHead(code, { "content-type": "text/plain" }); sock.end("Refusé par le filtre réseau de Searchtide"); }
    else { sock.end(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`); }
  };
  const authed = (h: string | undefined) => h === expected;

  const server = http.createServer(async (req, res) => {
    if (!authed(req.headers["proxy-authorization"] as string | undefined)) { res.writeHead(407, { "proxy-authenticate": 'Basic realm="st"' }); res.end(); return; }
    let u: URL;
    try { u = new URL(req.url ?? ""); } catch { return refuse(res, 400); }
    if (u.protocol !== "http:") return refuse(res);
    const port = u.port ? Number(u.port) : 80;
    const ip = await resolveTarget(u.hostname, port).catch(() => null);
    if (!ip) return refuse(res);
    stats.allowed += 1;
    const headers = { ...req.headers }; delete headers["proxy-authorization"]; delete headers["proxy-connection"];
    const up = http.request({ host: ip, port, method: req.method, path: u.pathname + u.search, headers: { ...headers, host: u.host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on("connect", async (req, client: net.Socket, head) => {
    sockets.add(client); client.on("close", () => sockets.delete(client)); client.on("error", () => {});
    if (!authed(req.headers["proxy-authorization"] as string | undefined)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="st"\r\n\r\n'); return; }
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    if (!m) return refuse(client, 400);
    const ip = await resolveTarget(m[1], Number(m[2])).catch(() => null);
    if (!ip) return refuse(client);
    stats.allowed += 1;
    const up = net.connect({ host: ip, port: Number(m[2]) }, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head); up.pipe(client); client.pipe(up); });
    sockets.add(up); up.on("close", () => sockets.delete(up));
    up.on("error", () => client.destroy()); client.on("close", () => up.destroy());
  });
  server.on("upgrade", (_req, socket: net.Socket) => refuse(socket));   // WebSocket en clair : refusé
  server.on("clientError", (_e, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, auth, stats, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); server.closeAllConnections?.(); }) };
}
