import type { ReactNode } from "react";

export const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "—" : n.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });

/** Évolution par rapport à la période précédente. `lowerIsBetter` pour la position Google. */
export function Delta({ now, before, lowerIsBetter = false, window }: { now: number | null; before: number | null; lowerIsBetter?: boolean; window: string }) {
  if (now == null || before == null || (!now && !before)) return <span className="text-muted">—</span>;
  if (!before) return <span className="text-muted">nouveau{window && ` · ${window}`}</span>;
  const change = lowerIsBetter ? before - now : ((now - before) / before) * 100;
  const text = lowerIsBetter
    ? `${change > 0 ? "+" : change < 0 ? "−" : ""}${fmt(Math.abs(change), 1)} place${Math.abs(change) >= 2 ? "s" : ""}`
    : `${change > 0 ? "+" : change < 0 ? "−" : ""}${fmt(Math.abs(change), 0)} %`;
  const tone = Math.abs(change) < 0.5 ? "text-muted" : change > 0 ? "text-positive" : "text-negative";
  return <span><span className={`num font-medium ${tone}`}>{text}</span> <span className="text-muted">{window}</span></span>;
}

export type Kpi = { id: string; label: string; value: ReactNode; delta?: ReactNode };

/** Bande de chiffres clés, sans boîtes. Ceux dont l'id est choisissable pilotent la série du graphique. */
export function KpiStrip({ items, selected, selectable = [], onSelect }: {
  items: Kpi[]; selected?: string; selectable?: string[]; onSelect?: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
      {items.map((k) => {
        const active = selected === k.id;
        const body = (
          <>
            <div className={`text-xs ${active ? "font-medium text-ink" : "text-muted"}`}>{k.label}</div>
            <div className="num mt-1 text-[28px] leading-9">{k.value}</div>
            <div className="mt-0.5 text-xs">{k.delta ?? <span className="text-muted">—</span>}</div>
          </>
        );
        return onSelect && selectable.includes(k.id) ? (
          <button key={k.id} onClick={() => onSelect(k.id)} aria-pressed={active}
            className={`border-t-2 pt-3 text-left transition-colors ${active ? "border-accent" : "border-rule hover:border-control"}`}>{body}</button>
        ) : <div key={k.id} className="border-t-2 border-rule pt-3">{body}</div>;
      })}
    </div>
  );
}

export function Section({ title, sub, action, children }: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-medium">{title}</h2>
          {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyBox({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-control px-3 py-2.5 text-sm text-muted">{children}</div>;
}

/** Tableau de parts : le fond arrondi de la ligne est la barre, proportionnelle à la première ligne. */
export function ShareTable({ title, rows, label, empty, map }: {
  title: string; rows: { key: string; visitors: number }[]; label: string; empty: string; map?: (k: string) => ReactNode;
}) {
  const max = Math.max(...rows.map((r) => r.visitors), 1);
  const total = rows.reduce((n, r) => n + r.visitors, 0);
  return (
    <Section title={title}>
      <div className="mb-1 flex justify-between px-3 text-xs text-muted"><span>{label}</span><span>Visiteurs</span></div>
      {rows.length ? (
        <ul className="space-y-0.5">
          {rows.slice(0, 6).map((r) => (
            <li key={r.key} className="relative flex h-9 items-center justify-between gap-3 px-3">
              {/* La barre reste dans la colonne du libellé : elle ne passe jamais sous les chiffres */}
              <span className="absolute inset-y-0 right-[112px] left-0" aria-hidden>
                <span className="block h-full rounded-md bg-accent-soft" style={{ width: `${(r.visitors / max) * 100}%` }} />
              </span>
              <span className="relative truncate">{map ? map(r.key) : r.key}</span>
              <span className="num relative flex shrink-0 items-baseline gap-3">
                <span className="w-10 text-right text-xs text-muted">{fmt((r.visitors / total) * 100)} %</span>
                <span className="w-12 text-right">{fmt(r.visitors)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : <EmptyBox>{empty}</EmptyBox>}
    </Section>
  );
}

type Col<T> = { label: string; render: (r: T) => ReactNode; num?: boolean; className?: string };

export function Table<T>({ rows, cols, empty, onRow }: { rows: T[]; cols: Col<T>[]; empty: string; onRow?: (r: T) => void }) {
  if (!rows.length) return <EmptyBox>{empty}</EmptyBox>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted">
            {cols.map((c, i) => <th key={i} className={`h-9 font-normal ${c.num ? "pl-4 text-right whitespace-nowrap" : "text-left"} ${c.className ?? ""}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow && (() => onRow(r))} className={`border-t border-rule ${onRow ? "cursor-pointer hover:bg-raised" : ""}`}>
              {cols.map((c, j) => (
                <td key={j} className={`h-11 ${c.num ? "num pl-4 text-right whitespace-nowrap" : "max-w-0 truncate pr-4"} ${c.className ?? ""}`}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Button({ children, variant = "primary", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const look = variant === "primary"
    ? "bg-primary text-surface hover:opacity-90"
    : "border border-control bg-surface text-ink hover:bg-raised";
  return <button {...p} className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition active:scale-[.98] disabled:opacity-50 ${look} ${p.className ?? ""}`}>{children}</button>;
}

export const fieldCls = "h-8 rounded-md border border-control bg-surface px-2.5 text-sm text-ink";
export const inputCls = `w-full ${fieldCls}`;

/** Barre grise à la taille réelle de la valeur attendue (chargement). */
export const Skeleton = ({ className = "" }: { className?: string }) => <span className={`block rounded bg-raised ${className}`} />;

export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect width="24" height="24" rx="6" fill="var(--color-accent)" />
      <path d="M4 15c2.7-4 5.3-4 8 0s5.3 4 8-1" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M4 10c2.7-3 5.3-3 8 0" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
