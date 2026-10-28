const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A wait such as `45s`, `4m 30s`, `3h 12m`, or `1d 5m`; seconds are dropped from an hour up. */
export function formatDuration(ms: number): string {
  let seconds = Math.max(0, Math.ceil(ms / 1_000));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds}s`);
  return parts.length === 0 ? "0s" : parts.join(" ");
}

/** Local time of day such as `4:35pm`, with seconds only when they are not zero. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = date.getSeconds() === 0 ? "" : `:${String(date.getSeconds()).padStart(2, "0")}`;
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes}${seconds}${hours < 12 ? "am" : "pm"}`;
}

function calendarDay(epochMs: number): number {
  const date = new Date(epochMs);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/** A due time qualified by its calendar day relative to now: `4:35pm`, `tomorrow 9:00am`, `Fri Oct 30 4:35pm`. */
export function formatWhen(dueAt: number, now: number): string {
  const clock = formatClock(dueAt);
  const days = calendarDay(dueAt) - calendarDay(now);
  if (days === 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  const date = new Date(dueAt);
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}${year} ${clock}`;
}

/** A prompt collapsed onto one line and shortened to at most `max` characters. */
export function preview(text: string, max = 60): string {
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("")}…`;
}
