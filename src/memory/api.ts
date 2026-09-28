import { policyFetch } from "../security/network.js";
import { apiUrl, loadConfig } from "../lib/config.js";
import { AuthError } from "../lib/api.js";
import type { CodebaseIndex } from "../domain/types.js";
import { accessGated, activeAccess, denyAccess, type AccessReason } from "../storage/access.js";

async function authed<T>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
  const token = loadConfig().token as string | undefined;
  if (!token) throw new AuthError("Not signed in. Run `kurtel login`.");

  const res = await policyFetch(`${apiUrl()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, "cloud");
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }

  if (res.status === 401) throw new AuthError("Your session is invalid or expired. Run `kurtel login`.");
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `error ${res.status}`);
  return data as T;
}

/** Uploads the graph digest (never source code) for this branch. A refusal turns Kurtel off here. */
export async function pushIndex(root: string, index: CodebaseIndex, commit: string): Promise<{ ok: boolean }> {
  const access = accessGated() ? activeAccess(root) : null;
  if (accessGated() && !access) throw new Error("This repository is not declared by your organization, or you have no access to it.");
  const branch = index.branch || "main";
  const digest = {
    ...index,
    commit,
    modules: index.modules.map((m) => ({
      ...m,
      exports: m.exports.slice(0, 10),
      symbols: (m.symbols ?? []).slice(0, 25).map((sy) => ({ ...sy, calls: sy.calls.slice(0, 15) })),
    })).slice(0, 3000),
  };
  const query = new URLSearchParams({ ...(access ? { remote: access.remote, organization: access.organization.id } : {}), repo: index.repo, branch });
  try {
    return await authed("PUT", `/api/memory/index?${query}`, digest);
  } catch (error) {
    const reason = (error as Error).message;
    if (["no_access", "not_declared", "organization_required"].includes(reason)) denyAccess(root, reason as AccessReason);
    throw error;
  }
}
