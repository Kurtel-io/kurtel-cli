import { policyFetch } from "../security/network.js";
import { apiUrl } from "./config.js";

export interface StartResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval: number;
  expires_in: number;
}

export type PollResponse =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "not_found" }
  | { status: "used" }
  | {
      status: "authorized";
      token: string;
      account: string | null;
      organization: string | null;
    };

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await policyFetch(`${apiUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, "cloud");

  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON response
  }

  if (!res.ok && res.status >= 500) {
    const msg =
      (data as { error?: string })?.error ?? `server error (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export function startDeviceAuth(): Promise<StartResponse> {
  return postJSON<StartResponse>("/api/cli/auth/start", {});
}

export function pollDeviceAuth(deviceCode: string): Promise<PollResponse> {
  return postJSON<PollResponse>("/api/cli/auth/poll", {
    device_code: deviceCode,
  });
}

import { loadConfig } from "./config.js";

export class AuthError extends Error {}

async function authed<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const token = loadConfig().token as string | undefined;
  if (!token) throw new AuthError("Not signed in. Run `kurtel login`.");

  const res = await policyFetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, "cloud");

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
