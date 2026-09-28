import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface NetworkPolicy { version: 1; mode: "cloud" | "offline" | "private"; engine_origins: string[] }
const bundledPolicy = () => existsSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)));
export const policyPath = () => process.env.KURTEL_POLICY_FILE ? resolve(process.env.KURTEL_POLICY_FILE) : bundledPolicy() ? fileURLToPath(new URL("../../network-policy.json", import.meta.url)) : join(homedir(), ".kurtel", "network-policy.json");
export function validatePolicy(value: unknown): NetworkPolicy {
  const p = value as NetworkPolicy;
  if (!p || p.version !== 1 || !["cloud", "offline", "private"].includes(p.mode) || !Array.isArray(p.engine_origins) || p.engine_origins.length > 16) throw new Error("Invalid network policy; network access refused");
  for (const origin of p.engine_origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Allow an exact HTTPS origin, or HTTP loopback origin");
  }
  if (p.mode !== "private" && p.engine_origins.length) throw new Error("Only private mode accepts engine origins");
  return p;
}
export function networkPolicy(): NetworkPolicy {
  const file = policyPath();
  if (!existsSync(file)) {
    if (process.env.KURTEL_POLICY_FILE || bundledPolicy()) throw new Error("Required network policy file is missing");
    return { version: 1, mode: "cloud", engine_origins: [] };
  }
  return validatePolicy(JSON.parse(readFileSync(file, "utf8")));
}
export function saveNetworkPolicy(policy: NetworkPolicy): void {
  if (process.env.KURTEL_POLICY_FILE || bundledPolicy()) throw new Error("Managed policy must be updated by its administrator");
  validatePolicy(policy);
  const file = policyPath(); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, file);
}
export function assertNetworkAllowed(target: string | URL, purpose: "cloud" | "engine"): void {
  const p = networkPolicy(), url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid network destination");
  if (p.mode === "cloud") return;
  if (p.mode === "private" && purpose === "engine" && p.engine_origins.includes(url.origin)) return;
  throw new Error(`Network policy ${p.mode} blocks ${purpose} requests`);
}
export function policyFetch(target: string | URL, options: RequestInit, purpose: "cloud" | "engine"): Promise<Response> {
  assertNetworkAllowed(target, purpose);
  // Do not let redirects escape the allowlist or forward credentials elsewhere.
  return fetch(target, { ...options, redirect: "error" });
}
export const cloudAllowed = () => networkPolicy().mode === "cloud";
