import { apiUrl, loadConfig } from "../lib/config.js";
import { accessGated, activeAccess, withholdMemory } from "../storage/access.js";
import { learningConfig } from "./session-learning.js";

export type EngineOperation = "extract" | "correction" | "context";

/** Where one request to the learning engine goes: URL, bearer credential, fields added to the body. */
export interface EngineTarget {
  url: URL;
  token: string;
  /** Network policy purpose: kurtel.io (cloud) or a configured engine. */
  purpose: "cloud" | "engine";
  /** Added to the request body: the repository the server checks access and memory for. */
  where: Record<string, string>;
}

/**
 * kurtel.io serves the engine to signed-in developers whose organization has memory, with their CLI token.
 * Enterprise deployments (and memory tests) use the engine set with `kurtel sessions engine <url>` and
 * KURTEL_ENGINE_TOKEN. Null without an engine: graph only.
 */
export function engineTarget(root: string, op: EngineOperation): EngineTarget | null {
  if (accessGated()) {
    const access = activeAccess(root), token = loadConfig().token as string | undefined;
    if (!access?.memory || !token) return null;
    return { url: new URL(`${apiUrl()}/api/memory/engine/${op}`), token, purpose: "cloud", where: { remote: access.remote, organization: access.organization.id } };
  }
  const config = learningConfig(root), token = process.env.KURTEL_ENGINE_TOKEN;
  if (!config.enabled || !config.endpoint || !token) return null;
  const url = new URL(config.endpoint);
  if (op !== "extract") { url.pathname = `/v1/${op}`; url.search = ""; }
  return { url, token, purpose: "engine", where: {} };
}

/** Same engine as when the request started (a sign-out, a switch or a new endpoint cancels its answer). */
export function sameEngine(root: string, op: EngineOperation, target: EngineTarget): boolean {
  const now = engineTarget(root, op);
  return !!now && now.url.href === target.url.href && now.token === target.token;
}

/** kurtel.io refused because the organization no longer has memory: graph only from now on. */
export async function noticeMemoryRefusal(root: string, target: EngineTarget, response: Response): Promise<void> {
  if (target.purpose !== "cloud" || response.status !== 403) return;
  try {
    const body = await response.clone().json() as { error?: string };
    if (body.error === "memory_not_enabled") withholdMemory(root);
  } catch { /* No readable refusal: nothing changes. */ }
}
