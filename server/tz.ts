// Heures locales ⇄ instants UTC, sans bibliothèque (Intl uniquement).
export function tzOffset(ts: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(ts).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
/** Instant UTC (ms) d'une heure locale « AAAA-MM-JJ HH:MM » dans le fuseau tz. */
export function zonedTs(day: string, hm: string, tz: string) {
  const [y, m, d] = day.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return guess - tzOffset(guess - tzOffset(guess, tz), tz);
}
