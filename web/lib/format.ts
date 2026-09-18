// SPEC §3.1 / §4 — display formatting. Inputs are seconds (number) or ISO strings;
// null/undefined/NaN render as an em dash so callers never branch on missing data.

const DASH = "—";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Split a non-negative number of seconds into h/m/s/ms with 3 dp on seconds. */
function split(seconds: number): { h: number; m: number; s: number; ms: number } {
  const total = Math.round(Math.abs(seconds) * 1000); // integer milliseconds
  const ms = total % 1000;
  const wholeSeconds = Math.floor(total / 1000);
  const s = wholeSeconds % 60;
  const m = Math.floor(wholeSeconds / 60) % 60;
  const h = Math.floor(wholeSeconds / 3600);
  return { h, m, s, ms };
}

/** `fmtLapTime(81.579)` → `1:21.579`. Minutes are unpadded; hours roll into minutes. */
export function fmtLapTime(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  const { h, m, s, ms } = split(seconds);
  const minutes = h * 60 + m;
  return `${minutes}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** `fmtRaceTime(5827.301)` → `1:37:07.301` (h:mm:ss.mmm). */
export function fmtRaceTime(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  const { h, m, s, ms } = split(seconds);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** `fmtGap(0.314)` → `+0.314s`; negative values keep their sign; `dp` defaults to 3. */
export function fmtGap(seconds: number | null | undefined, dp = 3): string {
  if (!isNum(seconds)) return DASH;
  const sign = seconds < 0 ? "-" : "+";
  return `${sign}${Math.abs(seconds).toFixed(dp)}s`;
}

/** Percentages: 3 dp below 1 %, else 2 dp. `fmtPct(0.0678)` → `0.068%`, `fmtPct(1.234)` → `1.23%`. */
export function fmtPct(pct: number | null | undefined, opts?: { signed?: boolean }): string {
  if (!isNum(pct)) return DASH;
  const dp = Math.abs(pct) < 1 ? 3 : 2;
  const body = `${Math.abs(pct).toFixed(dp)}%`;
  if (opts?.signed) return `${pct < 0 ? "-" : "+"}${body}`;
  return pct < 0 ? `-${body}` : body;
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** ISO date or timestamp → `21 Jul 2024`. Dates are formatted in UTC so a plain `YYYY-MM-DD` never shifts. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return DATE_FMT.format(d);
}

/** Signed fixed-point number: `fmtSigned(0.055)` → `+0.055`, `fmtSigned(-1.2, 2, 's')` → `-1.20s`, zero → `0.000`. */
export function fmtSigned(value: number | null | undefined, dp = 3, suffix = ""): string {
  if (!isNum(value)) return DASH;
  const rounded = Number(value.toFixed(dp));
  if (rounded === 0) return `${(0).toFixed(dp)}${suffix}`;
  return `${rounded > 0 ? "+" : "-"}${Math.abs(value).toFixed(dp)}${suffix}`;
}

/** `gpShortName('Hungarian Grand Prix')` → `Hungarian`; other names are returned trimmed. */
export function gpShortName(eventName: string | null | undefined): string {
  if (!eventName) return DASH;
  return eventName.replace(/\s*Grand Prix\s*$/i, "").trim() || eventName;
}
