// The days a fact holds. The engine speaks in days, both included (YYYY-MM-DD); the store keeps instants, the
// first one included and the last one excluded (validAt): local midnight starting the first day, and local
// midnight ending the last.

export const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && localDay(startOfDay(d)) === d;

export function localDay(iso: string): string {
  const t = new Date(iso);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function startOfDay(day: string, after = 0): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + after).toISOString();
}

/** Within its period at `time`: started, and not ended. */
export function inForce(v: { valid_from: string | null; valid_until: string | null }, time: number): boolean {
  return (!v.valid_from || Date.parse(v.valid_from) <= time) && (!v.valid_until || time < Date.parse(v.valid_until));
}

/** Engine days to stored instants; an unreadable or backwards period gives none. */
export function storedValidity(from: unknown, until: unknown): { valid_from: string | null; valid_until: string | null } {
  const first = isDay(from) ? from : null, last = isDay(until) ? until : null;
  if (first && last && first > last) return { valid_from: null, valid_until: null };
  return { valid_from: first ? startOfDay(first) : null, valid_until: last ? startOfDay(last, 1) : null };
}

/** Stored instants back to engine days. */
export function validityDays(v: { valid_from: string | null; valid_until: string | null }): { valid_from?: string; valid_until?: string } {
  return { ...(v.valid_from ? { valid_from: localDay(v.valid_from) } : {}), ...(v.valid_until ? { valid_until: localDay(new Date(Date.parse(v.valid_until) - 1).toISOString()) } : {}) };
}
