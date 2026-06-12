import { apiUrl, loadConfig } from "../lib/config.js";
import { AuthError } from "../lib/api.js";
import type { CodebaseIndex, DarwinPattern, TelemetryEvent } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// API mémoire — toujours via le backend Kurtel (qui parle à Supabase avec la
// service key), jamais Supabase en direct depuis le CLI : le token CLI existant
// suffit, pas d'anon key à distribuer, et la RLS reste un détail serveur.
//
// Endpoints attendus côté backend (cf. INTEGRATION.md):
//   GET    /api/memory/:repo/patterns?since=<iso>     → { patterns, synced_at }
//   PUT    /api/memory/:repo/index                    → { ok }
//   POST   /api/memory/:repo/telemetry                → { ok }
// ─────────────────────────────────────────────────────────────────────────────

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

const enc = (repo: string) => encodeURIComponent(repo);

/** Pull delta de la mémoire darwinienne (patterns) pour ce repo. */
export function pullPatterns(repo: string, since?: string | null): Promise<{
  patterns: DarwinPattern[];
  synced_at: string;
  /** true = réponse delta (merge), false = snapshot complet (replace). */
  delta: boolean;
}> {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return authed("GET", `/api/memory/${enc(repo)}/patterns${q}`);
}

/** Push de la mémoire de codebase (digest, jamais le code source) pour l'app web. */
export function pushIndex(repo: string, index: CodebaseIndex): Promise<{ ok: boolean }> {
  // On n'envoie pas le graphe complet module-par-module si énorme: digest borné.
  const digest = {
    ...index,
    modules: index.modules.map((m) => ({ ...m, exports: m.exports.slice(0, 10) })).slice(0, 3000),
  };
  return authed("PUT", `/api/memory/${enc(repo)}/index`, digest);
}

/** Push asynchrone de la télémétrie d'usage des patterns (signal de fitness). */
export function pushTelemetry(repo: string, events: TelemetryEvent[]): Promise<{ ok: boolean }> {
  return authed("POST", `/api/memory/${enc(repo)}/telemetry`, { events });
}
