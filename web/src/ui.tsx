import type { ReactNode } from "react";

export const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "—" : n.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });

export function Card({ title, children, className = "" }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900 ${className}`}>
      {title && <h3 className="mb-3 text-sm font-medium text-stone-500 dark:text-stone-400">{title}</h3>}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <div className="text-sm text-stone-500 dark:text-stone-400">{label}</div>
      <div className="num mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-stone-400">{hint}</div>}
    </Card>
  );
}

/** Courbe simple en SVG : pas de dépendance graphique. */
export function LineChart({ points, label }: { points: { x: string; y: number }[]; label: string }) {
  if (points.length < 2) return <p className="py-10 text-center text-sm text-stone-400">Pas encore assez de données.</p>;
  const W = 600, H = 160, max = Math.max(...points.map((p) => p.y), 1);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - (p.y / max) * (H - 10)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full text-tide-600" preserveAspectRatio="none" role="img" aria-label={label}>
        <path d={`${line} L${W},${H} L0,${H} Z`} className="fill-tide-500/10" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-stone-400">
        <span>{points[0].x}</span><span>max {fmt(max)}</span><span>{points.at(-1)!.x}</span>
      </figcaption>
    </figure>
  );
}

type Col<T> = { label: string; render: (r: T) => ReactNode; num?: boolean };

export function Table<T>({ rows, cols, empty = "Aucune donnée." }: { rows: T[]; cols: Col<T>[]; empty?: string }) {
  if (!rows.length) return <p className="py-4 text-sm text-stone-400">{empty}</p>;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-stone-400">
            {cols.map((c) => <th key={c.label} className={`pb-2 font-normal ${c.num ? "pl-3 text-right whitespace-nowrap" : ""}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-stone-100 dark:border-stone-800">
              {cols.map((c) => (
                <td key={c.label} className={`py-1.5 ${c.num ? "num pl-3 text-right whitespace-nowrap" : "w-full max-w-0 truncate pr-3"}`}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Button({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...p} className={`rounded-lg bg-tide-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-tide-700 disabled:opacity-50 ${p.className ?? ""}`}>
      {children}
    </button>
  );
}

export const fieldCls = "rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900";
export const inputCls = `w-full ${fieldCls}`;
