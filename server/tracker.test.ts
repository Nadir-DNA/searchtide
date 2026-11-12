// 1.10 : dans un faux DOM, la 1re vue porte le référent externe, les suivantes la page précédente,
// et replaceState ne crée aucune vue (chemin inchangé ou non : jamais de double comptage).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./tracker.js", import.meta.url), "utf8");

function fakeDom(startPath = "/a") {
  const sent: Record<string, string>[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const location = {
    origin: "https://exemple.com", hostname: "exemple.com", search: "", href: "",
    pathname: startPath,
    get url() { return this.origin + this.pathname + this.search; },
  };
  const sync = () => { location.href = location.url; };
  const history = {
    pushState(_s: unknown, _t: string, url?: string) { if (url) location.pathname = url; sync(); },
    replaceState(_s: unknown, _t: string, url?: string) { if (url) location.pathname = url; sync(); },
  };
  const document = {
    referrer: "https://www.google.com/",
    currentScript: { src: "https://exemple.com/script.js", getAttribute: () => "exemple.com" },
    addEventListener() {},
  };
  const navigator = { webdriver: false, language: "fr-FR", sendBeacon: (_u: string, body: string) => { sent.push(JSON.parse(body)); return true; } };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const context = {
    document, navigator, localStorage, location, history, URL,
    addEventListener: (name: string, f: () => void) => { (listeners[name] ??= []).push(f); },
    window: {} as Record<string, unknown>,
  };
  sync();
  vm.createContext(context);
  vm.runInContext(source, context);
  return { sent, listeners, location, history };
}

test("1.10 : référent externe puis page précédente, replaceState sans vue", () => {
  const dom = fakeDom("/a");
  assert.equal(dom.sent.length, 1);
  assert.equal(dom.sent[0].referrer, "https://www.google.com/", "première vue : référent externe");
  assert.equal(dom.sent[0].url, "https://exemple.com/a");

  dom.history.pushState({}, "", "/b");
  assert.equal(dom.sent.length, 2);
  assert.equal(dom.sent[1].referrer, "https://exemple.com/a", "vue suivante : page précédente");

  dom.history.replaceState({}, "", "/b");
  assert.equal(dom.sent.length, 2, "replaceState à chemin inchangé : aucune vue");

  dom.history.replaceState({}, "", "/c");
  assert.equal(dom.sent.length, 2, "replaceState à chemin changé : aucune vue (pas de double comptage)");

  dom.history.pushState({}, "", "/c");
  assert.equal(dom.sent.length, 3, "pushState vers un nouveau chemin : une vue");
  assert.equal(dom.sent[2].referrer, "https://exemple.com/b");
});
