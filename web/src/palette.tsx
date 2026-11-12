// 1.7 / B1 / B9 : palette de commandes (Ctrl/⌘+K ou « / ») et aide des raccourcis (« ? »).
// Liste sites, projets et vues ; filtre par saisie ; clavier (flèches, Entrée, Échap), focus piégé puis rendu.
import { useEffect, useRef, useState } from "react";
import { useDrawerKeys } from "./useDrawerKeys";

type Go = (n: Record<string, string | undefined>) => void;
type Entry = { key: string; label: string; hint: string; run: () => void };

export function CommandPalette({ demo = false, sites, projects, go, onClose }: {
  demo?: boolean; sites: string[]; projects: { id: string; name: string }[]; go: Go; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useDrawerKeys(ref, onClose);
  useEffect(() => { previous.current = document.activeElement as HTMLElement | null; }, []);
  useEffect(() => () => previous.current?.focus?.(), []);

  const entries: Entry[] = [
    { key: "today", label: "Aujourd'hui", hint: "Vue", run: () => go({ site: undefined, view: undefined, id: undefined, tab: undefined }) },
    { key: "pages", label: "Tableaux de bord", hint: "Vue", run: () => go({ site: undefined, view: "page", id: undefined }) },
    { key: "projects", label: "Projets", hint: "Vue", run: () => go({ site: undefined, view: "projects", id: undefined }) },
    ...(demo ? [] : [{ key: "connections", label: "Connexions", hint: "Vue", run: () => go({ site: undefined, view: "connections", id: undefined }) }]),
    { key: "settings", label: "Réglages", hint: "Vue", run: () => go({ site: undefined, view: "settings", id: undefined }) },
    ...sites.map((domain) => ({ key: `site:${domain}`, label: domain, hint: "Site", run: () => go({ site: domain, view: undefined, id: undefined, tab: undefined }) })),
    ...projects.map((p) => ({ key: `project:${p.id}`, label: p.name, hint: "Projet", run: () => go({ site: undefined, view: "project", id: p.id }) })),
  ];
  const shown = query ? entries.filter((e) => `${e.label} ${e.hint}`.toLowerCase().includes(query.toLowerCase())) : entries;
  const pick = (e?: Entry) => { if (!e) return; e.run(); onClose(); };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Palette de commandes" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); pick(shown[active]); }
          }}
          aria-label="Rechercher un site, un projet ou une vue" placeholder="Site, projet, vue…"
          className="h-12 w-full border-b border-border bg-transparent px-4 text-sm text-ink outline-none placeholder:text-muted" />
        <ul className="max-h-80 overflow-y-auto py-1">
          {shown.length === 0 && <li className="px-4 py-3 text-sm text-muted">Aucun résultat.</li>}
          {shown.map((entry, i) => (
            <li key={entry.key}>
              <button type="button" onMouseEnter={() => setActive(i)} onClick={() => pick(entry)} aria-current={i === active ? "true" : undefined}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${i === active ? "bg-active text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span><span className="shrink-0 text-xs text-muted">{entry.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  useDrawerKeys(ref, onClose);
  useEffect(() => { previous.current = document.activeElement as HTMLElement | null; }, []);
  useEffect(() => () => previous.current?.focus?.(), []);
  const rows = [["Ctrl/⌘ + K", "Ouvrir la palette"], ["/", "Ouvrir la palette"], ["?", "Cette aide"], ["Échap", "Fermer"]];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Raccourcis clavier" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-lg font-medium">Raccourcis clavier</h2>
        <dl className="mt-4 space-y-2 text-sm">
          {rows.map(([k, v]) => <div key={k} className="flex items-center justify-between gap-4"><dt className="num rounded bg-raised px-2 py-0.5 font-mono text-xs">{k}</dt><dd className="text-muted">{v}</dd></div>)}
        </dl>
        <p className="mt-4 text-xs text-muted">Les raccourcis ne s'activent pas dans un champ de saisie.</p>
      </div>
    </div>
  );
}
