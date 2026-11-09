import type { ReactNode } from "react";

export const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "—" : n.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6 ${className}`}>
      {(title || action) && (
        <div className="mb-5 flex min-h-8 flex-wrap items-center justify-between gap-3">
          {typeof title === "string" ? <h2 className="text-lg font-light">{title}</h2> : title}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "positive" | "negative" | "neutral"; children: ReactNode }) {
  const look = tone === "positive" ? "bg-positive-bg text-positive" : tone === "negative" ? "bg-negative-bg text-negative" : "bg-raised text-muted";
  return <span className={`num inline-flex h-6 shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap ${look}`}>{children}</span>;
}

/** Évolution par rapport à la période précédente, en pastille. Vert = bonne nouvelle (pour la position : une baisse). */
export function Delta({ now, before, lowerIsBetter = false }: { now: number | null; before: number | null; lowerIsBetter?: boolean }) {
  if (now == null || before == null || (!now && !before)) return null;
  if (!before) return <Pill>nouveau</Pill>;
  const change = lowerIsBetter ? before - now : ((now - before) / before) * 100;
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  const text = lowerIsBetter ? `${sign}${fmt(Math.abs(change), 1)}` : `${sign}${fmt(Math.abs(change), 1)} %`;
  return <Pill tone={Math.abs(change) < 0.05 ? "neutral" : change > 0 ? "positive" : "negative"}>{text}</Pill>;
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-full border border-border bg-raised p-1">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} aria-pressed={value === v}
          className={`h-7 rounded-full px-3 text-[13px] whitespace-nowrap transition-colors ${value === v ? "bg-active text-ink shadow-[inset_0_0_0_1px_var(--color-control)]" : "text-muted hover:text-ink"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Carte de chiffre clé. Cliquable quand elle choisit la série du graphique. */
export function KpiCard({ label, value, delta, active, onClick, hint }: {
  label: string; value: ReactNode; delta?: ReactNode; active?: boolean; onClick?: () => void; hint?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-[13px] text-muted">
        <span>{label}</span>
        {active && <span className="size-2 rounded-full bg-accent" aria-hidden />}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="num text-[28px] leading-9 font-light">{value}</span>
        {delta}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </>
  );
  const cls = `min-w-0 rounded-2xl border bg-surface p-5 text-left transition-colors ${active ? "border-control" : "border-border"}`;
  return onClick
    ? <button onClick={onClick} aria-pressed={active} className={`${cls} hover:border-control active:scale-[.99]`}>{body}</button>
    : <div className={cls}>{body}</div>;
}

export function EmptyBox({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-control px-4 py-3 text-sm text-muted">{children}</div>;
}

/** Liste classée : le fond arrondi de chaque ligne est la barre, dans la colonne du libellé uniquement. */
export function ShareList({ rows, label, empty, map }: {
  rows: { key: string; visitors: number }[]; label: string; empty: string; map?: (k: string) => ReactNode;
}) {
  if (!rows.length) return <EmptyBox>{empty}</EmptyBox>;
  const max = Math.max(...rows.map((r) => r.visitors), 1);
  const total = rows.reduce((n, r) => n + r.visitors, 0);
  return (
    <>
      <div className="mb-1.5 flex justify-between px-3 text-xs text-muted"><span>{label}</span><span>Visiteurs</span></div>
      <ul className="space-y-1">
        {rows.slice(0, 6).map((r, i) => (
          <li key={r.key} className="relative flex h-9 items-center justify-between gap-3 px-3">
            <span className="absolute inset-y-0 right-[104px] left-0" aria-hidden>
              <span className={`block h-full rounded-xl ${i === 0 ? "bg-active" : "bg-raised"}`} style={{ width: `${(r.visitors / max) * 100}%` }} />
            </span>
            <span className="relative truncate">{map ? map(r.key) : r.key}</span>
            <span className="num relative flex shrink-0 items-baseline gap-3">
              <span className="w-10 text-right text-xs text-muted">{fmt((r.visitors / total) * 100)} %</span>
              <span className="w-12 text-right">{fmt(r.visitors)}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

type Col<T> = { label: string; render: (r: T) => ReactNode; num?: boolean; className?: string };

export function Table<T>({ rows, cols, empty, onRow }: { rows: T[]; cols: Col<T>[]; empty: string; onRow?: (r: T) => void }) {
  if (!rows.length) return <EmptyBox>{empty}</EmptyBox>;
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted">
            {cols.map((c, i) => <th key={i} className={`h-9 px-2 font-normal ${c.num ? "text-right whitespace-nowrap" : "text-left"} ${c.className ?? ""}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow && (() => onRow(r))} className={`border-t border-rule ${onRow ? "cursor-pointer transition-colors hover:bg-raised" : ""}`}>
              {cols.map((c, j) => (
                <td key={j} className={`h-12 px-2 ${c.num ? "num text-right whitespace-nowrap" : "max-w-0 truncate"} ${c.className ?? ""}`}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Button({ children, variant = "primary", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "accent" }) {
  const look = variant === "primary"
    ? "bg-ink text-ground hover:opacity-90"
    : variant === "accent"
      ? "bg-accent text-on-accent hover:opacity-90"
      : "border border-control bg-raised text-ink hover:bg-active";
  return <button {...p} className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium transition active:scale-[.98] disabled:opacity-50 ${look} ${p.className ?? ""}`}>{children}</button>;
}

/**
 * Rend le focus à l'élément d'origine après la fermeture d'un panneau (à appeler depuis un useEffect, qui renvoie l'annulation).
 * Léger délai voulu : Chromium rétablit lui-même le focus sur le premier élément focalisable un ou deux cycles de rendu
 * après le retrait de l'élément qui l'avait, ce qui écrasait une restauration immédiate (course observée en e2e).
 */
export function restoreFocus(el: HTMLElement | null | undefined) {
  const id = window.setTimeout(() => el?.focus(), 60);
  return () => window.clearTimeout(id);
}

export const inputCls = "h-10 w-full rounded-lg border border-control bg-raised px-3 text-sm text-ink placeholder:text-muted";

/** Barre grise à la taille réelle de la valeur attendue (chargement). */
export const Skeleton = ({ className = "" }: { className?: string }) => <span className={`block rounded-xl bg-raised ${className}`} />;

export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect width="24" height="24" rx="7" fill="var(--color-accent)" />
      <path d="M4 15c2.7-4 5.3-4 8 0s5.3 4 8-1" fill="none" stroke="var(--color-on-accent)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M4 10c2.7-3 5.3-3 8 0" fill="none" stroke="var(--color-on-accent)" strokeOpacity=".45" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** Icônes de navigation (trait 1,5 px, 16 px). */
export const Icon = {
  grid: <path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" />,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.7 1.6 9.3 0 11M8 2.5c-1.6 1.7-1.6 9.3 0 11" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  book: <path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3zM13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13z" />,
  out: <path d="M6 13H3.5V3H6M10 5l3 3-3 3M13 8H6" />,
  users: <><circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5c.5-2.5 2.3-3.8 4.5-3.8s4 1.3 4.5 3.8M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.9c1.1.6 1.8 1.8 2 3.6" /></>,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="2" /><path d="m2.5 4.5 5.5 4 5.5-4" /></>,
  bot: <><rect x="3" y="5" width="10" height="8" rx="2.5" /><path d="M8 2.5V5M6 9h.01M10 9h.01M1.5 9v1.5M14.5 9v1.5" /></>,
  link: <><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.1-2.1a3 3 0 0 0-4.2-4.2L7.5 4.3" /><path d="M9.5 6.5a3 3 0 0 0-4.2 0L3.2 8.6a3 3 0 0 0 4.2 4.2l1.1-1.1" /></>,
  calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></>,
};
export const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 16 16" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
