import { useLayoutEffect, useRef, useState } from "react";
import { fmt } from "./ui";

/** Graduations rondes (1, 2, 2,5 ou 5 × 10^n) dont la dernière dépasse le maximum. */
export function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step === max ? max + step : Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6));
}

const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { ...opts, timeZone: "UTC" });

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Barres arrondies : une par jour, ou par semaine au-delà de 62 jours. La dernière (ou celle survolée) prend l'accent. */
export function BarChart({ days, values, label, height = 300, markers = [], color = "var(--color-accent)" }: { days: string[]; values: number[]; label: string; height?: number; markers?: { day: string; label: string }[]; color?: string }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  // Regroupement par semaine pour les longues périodes (plus lisible que 365 barres)
  const weekly = values.length > 62;
  const buckets = weekly
    ? Array.from({ length: Math.ceil(values.length / 7) }, (_, i) => ({ day: days[i * 7], value: values.slice(i * 7, i * 7 + 7).reduce((a, b) => a + b, 0) }))
    : days.map((day, i) => ({ day, value: values[i] }));
  const n = buckets.length;
  const ys = ticks(Math.max(...buckets.map((b) => b.value), 0));
  const yMax = ys.at(-1)!;
  const top = 12, bottom = 28;
  const left = Math.max(...ys.map((t) => fmt(t).length)) * 7 + 14;
  const plotW = Math.max(w - left, 10), plotH = height - top - bottom;
  const slot = plotW / Math.max(n, 1);
  const barW = Math.max(2, Math.min(28, slot * 0.56));
  const cx = (i: number) => left + slot * i + slot / 2;
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const focus = hover ?? n - 1;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 84))));

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(Math.max(Math.floor((e.clientX - r.left - left) / slot), 0), n - 1));
  }
  const tipLeft = Math.min(Math.max(cx(focus) + barW / 2 + 10, 0), w - 150);
  const tipFlip = cx(focus) + barW / 2 + 160 > w;

  return (
    <div ref={ref} className="relative">
      {w > 0 && n > 0 && (
        <svg width={w} height={height} role="img" className="block touch-none" onPointerMove={move} onPointerLeave={() => setHover(null)}
          aria-label={`${label} ${weekly ? "par semaine" : "par jour"}, du ${dayLabel(days[0])} au ${dayLabel(days.at(-1)!)}`}>
          {ys.map((t) => (
            <g key={t}>
              <line x1={left} x2={w} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" strokeDasharray={t ? "3 4" : undefined} />
              <text x={left - 12} y={y(t) + 4} textAnchor="end" fontSize="12" fill="var(--color-muted)" className="num">{fmt(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const h = Math.max(y(0) - y(b.value), b.value ? 4 : 2);
            return (
              <rect key={i} x={cx(i) - barW / 2} y={y(0) - h} width={barW} height={h} rx={Math.min(barW / 2, 10)}
                fill={i === focus ? color : "var(--color-control)"} style={{ transition: "fill .15s" }} />
            );
          })}
          {/* Repères (publications, notes) : un point sous la barre du jour, détail au survol */}
          {markers.map((m, k) => {
            const idx = days.indexOf(m.day);
            if (idx < 0) return null;
            const i = weekly ? Math.floor(idx / 7) : idx;
            return <circle key={k} cx={cx(i)} cy={y(0) + 6} r={3.5} fill="var(--color-chart-2)"><title>{`${dayLabel(m.day)} : ${m.label}`}</title></circle>;
          })}
          {buckets.map((b, i) => (n - 1 - i) % every === 0 && (
            <text key={i} x={cx(i)} y={height - 8} textAnchor="middle" fontSize="12" fill={i === focus ? "var(--color-ink)" : "var(--color-muted)"}>
              {dayLabel(b.day, n <= 8 ? { weekday: "short" } : undefined)}
            </text>
          ))}
        </svg>
      )}
      {w > 0 && hover !== null && (
        <div className="pointer-events-none absolute rounded-xl border border-control bg-raised px-3 py-2 text-xs shadow-lg"
          style={{ left: tipFlip ? Math.max(cx(focus) - barW / 2 - 150, 0) : tipLeft, top: Math.max(y(buckets[focus].value) - 8, 0) }}>
          <div className="num flex items-center gap-2 text-sm font-medium"><span className="size-2 rounded-full" style={{ background: color }} />{fmt(buckets[focus].value)}</div>
          <div className="mt-0.5 text-muted">{weekly ? `Semaine du ${dayLabel(buckets[focus].day)}` : dayLabel(buckets[focus].day, { weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
      )}
    </div>
  );
}

/** Barres empilées par série (un projet = une couleur). Survol : le détail du jour, série par série. */
export function StackedBars({ days, series, rows, label, height = 280 }: {
  days: string[]; series: { key: string; label: string; color: string }[]; rows: Record<string, number>[]; label: string; height?: number;
}) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const weekly = days.length > 62;
  const buckets = weekly
    ? Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => ({ day: days[i * 7], v: Object.fromEntries(series.map((s) => [s.key, rows.slice(i * 7, i * 7 + 7).reduce((n, r) => n + (r[s.key] ?? 0), 0)])) }))
    : days.map((day, i) => ({ day, v: rows[i] }));
  const totals = buckets.map((b) => series.reduce((n, s) => n + (b.v[s.key] ?? 0), 0));
  const n = buckets.length;
  const ys = ticks(Math.max(...totals, 0));
  const yMax = ys.at(-1)!;
  const top = 12, bottom = 28;
  const left = Math.max(...ys.map((t) => fmt(t).length)) * 7 + 14;
  const plotW = Math.max(w - left, 10), plotH = height - top - bottom;
  const slot = plotW / Math.max(n, 1);
  const barW = Math.max(2, Math.min(24, slot * 0.6));
  const cx = (i: number) => left + slot * i + slot / 2;
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 84))));
  function move(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(Math.max(Math.floor((e.clientX - r.left - left) / slot), 0), n - 1));
  }
  const f = hover ?? -1;
  return (
    <div ref={ref} className="relative">
      {w > 0 && n > 0 && (
        <svg width={w} height={height} role="img" className="block touch-none" onPointerMove={move} onPointerLeave={() => setHover(null)}
          aria-label={`${label} ${weekly ? "par semaine" : "par jour"}, du ${dayLabel(days[0])} au ${dayLabel(days.at(-1)!)}`}>
          {ys.map((t) => (
            <g key={t}>
              <line x1={left} x2={w} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" />
              <text x={left - 12} y={y(t) + 4} textAnchor="end" fontSize="12" fill="var(--color-muted)" className="num">{fmt(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            let acc = 0;
            return (
              <g key={i} opacity={f < 0 || f === i ? 1 : 0.35} style={{ transition: "opacity .15s" }}>
                {series.map((s) => {
                  const v = b.v[s.key] ?? 0;
                  if (!v) return null;
                  const y1 = y(acc), y2 = y(acc + v);
                  acc += v;
                  return <rect key={s.key} x={cx(i) - barW / 2} y={y2} width={barW} height={Math.max(y1 - y2 - 1, 1)} rx={Math.min(2, barW / 4)} fill={s.color} />;
                })}
              </g>
            );
          })}
          {buckets.map((b, i) => (n - 1 - i) % every === 0 && (
            <text key={i} x={cx(i)} y={height - 8} textAnchor="middle" fontSize="12" fill={i === f ? "var(--color-ink)" : "var(--color-muted)"}>
              {dayLabel(b.day, n <= 8 ? { weekday: "short" } : undefined)}
            </text>
          ))}
        </svg>
      )}
      {w > 0 && hover !== null && (
        <div className="pointer-events-none absolute z-10 min-w-44 rounded-lg border border-control bg-raised px-3 py-2 text-xs shadow-lg"
          style={{ left: cx(f) + 190 > w ? Math.max(cx(f) - barW / 2 - 186, 0) : cx(f) + barW / 2 + 10, top: top }}>
          <div className="mb-1.5 text-muted">{weekly ? `Semaine du ${dayLabel(buckets[f].day)}` : dayLabel(buckets[f].day, { weekday: "long", day: "numeric", month: "long" })}</div>
          {series.filter((s) => buckets[f].v[s.key]).map((s) => (
            <div key={s.key} className="flex items-center gap-2 py-0.5"><span className="size-2 rounded-sm" style={{ background: s.color }} /><span className="flex-1">{s.label}</span><span className="num">{fmt(buckets[f].v[s.key])}</span></div>
          ))}
          <div className="mt-1 flex justify-between border-t border-rule pt-1 font-medium"><span>Total</span><span className="num">{fmt(totals[f])}</span></div>
        </div>
      )}
    </div>
  );
}

const PALETTE = ["var(--color-accent)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)"];

/** Anneau de répartition : 3 parts nommées au plus, le reste regroupé dans « Autres ». */
export function Donut({ parts, total, totalLabel }: { parts: { label: string; value: number }[]; total: number; totalLabel: string }) {
  const sorted = parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const shown = sorted.length > 4 ? [...sorted.slice(0, 3), { label: "Autres", value: sorted.slice(3).reduce((n, p) => n + p.value, 0) }] : sorted;
  const sum = shown.reduce((n, p) => n + p.value, 0) || 1;
  const R = 70, r = 46, C = 90;
  let a = -Math.PI / 2;
  const arcs = shown.map((p, i) => {
    const span = (p.value / sum) * Math.PI * 2;
    const gap = shown.length > 1 ? 0.035 : 0;
    const a0 = a + gap / 2, a1 = a + span - gap / 2;
    a += span;
    const pt = (rad: number, ang: number) => `${C + rad * Math.cos(ang)},${C + rad * Math.sin(ang)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = span >= Math.PI * 2 - 0.001
      ? `M${C - R},${C}a${R},${R} 0 1,0 ${2 * R},0a${R},${R} 0 1,0 ${-2 * R},0M${C - r},${C}a${r},${r} 0 1,1 ${2 * r},0a${r},${r} 0 1,1 ${-2 * r},0`
      : `M${pt(R, a0)}A${R},${R} 0 ${large} 1 ${pt(R, a1)}L${pt(r, a1)}A${r},${r} 0 ${large} 0 ${pt(r, a0)}Z`;
    return <path key={p.label} d={d} fill={PALETTE[i]} fillRule="evenodd" />;
  });
  return (
    <div>
      <div className="relative mx-auto w-[180px]">
        <svg viewBox="0 0 180 180" className="block w-full" role="img" aria-label={shown.map((p) => `${p.label} ${fmt((p.value / sum) * 100)} %`).join(", ")}>{arcs}</svg>
        <div className="absolute inset-0 grid place-content-center text-center">
          <div className="num text-2xl font-light">{fmt(total)}</div>
          <div className="text-xs text-muted">{totalLabel}</div>
        </div>
      </div>
      <ul className="mt-5 space-y-2">
        {shown.map((p, i) => (
          <li key={p.label} className="flex items-center gap-2.5 text-sm">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: PALETTE[i] }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            <span className="num text-muted">{fmt((p.value / sum) * 100)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Complète les jours sans données par des zéros, pour un axe du temps régulier. */
export function fillDays<T extends { day: string }>(rows: T[], from: string, to: string, pick: (r: T) => number) {
  const byDay = new Map(rows.map((r) => [r.day, pick(r)]));
  const days: string[] = [], values: number[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push(d); values.push(byDay.get(d) ?? 0);
  }
  return { days, values };
}
