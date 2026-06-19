import { apiUrl, loadConfig } from "../lib/config.js";
import { AuthError } from "../lib/api.js";
import type { CodebaseIndex, DarwinPattern, TelemetryEvent } from "./store.js";

// ── API mémoire kurtel-app ──
// repo passé en query param (?repo=owner/name): un "/" dans un segment de path Next.js/Vercel est fragile.

async function authed<T>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
  const token = loadConfig().token as string | undefined;
  if (!token) throw new AuthError("Not signed in. Run `kurtel login`.");

  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }

  if (res.status === 401) throw new AuthError("Your session is invalid or expired. Run `kurtel login`.");
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `error ${res.status}`);
  return data as T;
}

const q = (repo: string, extra: Record<string, string> = {}) =>
  "?" + new URLSearchParams({ repo, ...extra }).toString();

/** Pull delta de la mémoire darwinienne (repo_skills côté backend). */
export function pullPatterns(repo: string, since?: string | null): Promise<{
  patterns: DarwinPattern[];
  synced_at: string;
  delta: boolean;
}> {
  return authed("GET", `/api/memory/patterns${q(repo, since ? { since } : {})}`);
}

/** Push de la mémoire de codebase (digest, jamais le code source) — par branche. */
export function pushIndex(repo: string, index: CodebaseIndex): Promise<{ ok: boolean }> {
  const branch = index.branch || "main";
  const digest = {
    ...index,
    modules: index.modules.map((m) => ({
      ...m,
      exports: m.exports.slice(0, 10),
      symbols: (m.symbols ?? []).slice(0, 25).map((sy) => ({ ...sy, calls: sy.calls.slice(0, 15) })),
    })).slice(0, 3000),
  };
  return authed("PUT", `/api/memory/index${q(repo, { branch })}`, digest);
}

/** Push asynchrone de la télémétrie d'usage des patterns. */
export function pushTelemetry(repo: string, events: TelemetryEvent[]): Promise<{ ok: boolean }> {
  return authed("POST", `/api/memory/telemetry${q(repo)}`, { events });
}
