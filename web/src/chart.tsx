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

const shortDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });

/** Courbe d'une seule série : segments droits, 4-5 graduations discrètes, info-bulle au survol. */
export function LineChart({ days, values, label, format = (n: number) => fmt(n) }: {
  days: string[]; values: number[]; label: string; format?: (n: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 218, top = 8, bottom = 24;
  const ys = ticks(Math.max(...values, 0));
  const yMax = ys.at(-1)!;
  const left = Math.max(...ys.map((t) => format(t).length)) * 7 + 12;
  const plotW = Math.max(w - left, 10), plotH = H - top - bottom;
  const x = (i: number) => left + (values.length < 2 ? plotW / 2 : (i / (values.length - 1)) * plotW);
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  // Étiquettes de dates sur un pas régulier qui tombe sur le dernier jour
  const step = Math.max(1, Math.ceil((values.length - 1) / Math.max(2, Math.min(6, Math.floor(plotW / 110)))));
  const xLabels = values.map((_, i) => i).filter((i) => (values.length - 1 - i) % step === 0);

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - left) / plotW) * (values.length - 1));
    setHover(Math.min(Math.max(i, 0), values.length - 1));
  }

  return (
    <div ref={box} className="relative">
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`${label} par jour, du ${shortDay(days[0])} au ${shortDay(days.at(-1)!)}`}
          onPointerMove={move} onPointerLeave={() => setHover(null)} className="block touch-none">
          {ys.map((t) => (
            <g key={t}>
              <line x1={left} x2={w} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" strokeWidth={t === 0 ? 1.5 : 1} />
              <text x={left - 10} y={y(t) + 4} textAnchor="end" fontSize="12" fill="var(--color-muted)" className="num">{format(t)}</text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} x={x(i)} y={H - 6} fontSize="12" fill="var(--color-muted)"
              textAnchor={i === 0 ? "start" : i === values.length - 1 ? "end" : "middle"}>{shortDay(days[i])}</text>
          ))}
          <path d={`${line}L${x(values.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill="var(--color-accent)" opacity="0.08" />
          <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={top} y2={y(0)} stroke="var(--color-control)" />
              <circle cx={x(hover)} cy={y(values[hover])} r="4" fill="var(--color-surface)" stroke="var(--color-accent)" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 rounded-md border border-border bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-sm"
          style={{ left: Math.min(Math.max(x(hover) - 60, 0), w - 140) }}>
          <span className="text-muted">{shortDay(days[hover])}</span> <span className="num ml-1 font-medium">{format(values[hover])}</span>
        </div>
      )}
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
