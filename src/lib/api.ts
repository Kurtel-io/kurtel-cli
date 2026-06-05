// ── Authenticated API (uses the stored CLI token) ──────────────────────────

import { loadConfig } from "./config.js";

export class AuthError extends Error {}

export interface Run {
  id: string;
  task: string;
  repo: string | null;
  branch: string;
  engine: string;
  status: string;
  sandbox_id: string | null;
  result?: { summary?: string; diff?: string; pr_url?: string } | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
}

async function authed<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const token = loadConfig().token as string | undefined;
  if (!token) throw new AuthError("Not signed in. Run `kurtel login`.");

  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}

  if (res.status === 401) {
    throw new AuthError("Your session is invalid or expired. Run `kurtel login`.");
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `error ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export function verifyToken(): Promise<{
  account: string | null;
  organization: string | null;
  role: string | null;
}> {
  return authed("GET", "/api/cli/me");
}

export function createRun(input: {
  task: string; repo?: string; branch?: string; engine?: string;
}): Promise<Run> {
  return authed("POST", "/api/runs", input);
}

export function listRuns(): Promise<{ runs: Run[] }> {
  return authed("GET", "/api/runs");
}

export function getRun(id: string): Promise<Run> {
  return authed("GET", `/api/runs/${id}`);
}

export function getRunLogs(id: string): Promise<{ status: string; logs: string }> {
  return authed("GET", `/api/runs/${id}/logs`);
}

export function cancelRun(id: string): Promise<{ ok: boolean; status: string }> {
  return authed("DELETE", `/api/runs/${id}`);
}