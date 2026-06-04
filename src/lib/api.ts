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
  const res = await fetch(`${apiUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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