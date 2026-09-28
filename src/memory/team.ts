import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, knowledgePath, readKnowledge } from "../storage/knowledge.js";
import { policyFetch } from "../security/network.js";
import { localIdentity } from "../storage/local-identity.js";
import type { ContextItem } from "../context/budget.js";
import { apiUrl, loadConfig } from "../lib/config.js";
import { installTeamGuidance, removeTeamGuidance } from "../integrations/team-guidance.js";

export interface TeamIdentity { protocol: 2; actor: string; grants: { team: string; repo: string; role: "reader" | "member" | "lead" }[]; expires_at: string }
interface Session { endpoint: string; token: string; identity: TeamIdentity; transport?: "cloud" | "engine" }
interface Binding { endpoint: string; team: string; repo: string }
export interface Publication {
  id: string; expected_version: number; kind: "lesson" | "decision"; content: string; files: string[];
  evidence: { kind: "commit" | "pull_request" | "document"; reference: string; summary: string; revision: string | null }[];
  reason: string; expires_in_days: number;
}
interface TeamRecord {
  team: string; repo: string; id: string; version: number; kind: "lesson" | "decision"; author: string; promoted_by: string; promoter_role: string; expires_at: string;
  batch: { versions: { id: string; content: string; zones: string[] }[]; sources: { reference: string; content: string }[]; events?: { kind: string; content: string }[] };
}
const sessionFile = () => join(homedir(), ".kurtel", "team-session.json");
const bindingFile = (root: string) => join(dirname(knowledgePath(root)), "team.json");
function atomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  try { renameSync(tmp, file); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
function session(): Session | null {
  if (!existsSync(sessionFile())) return null;
  const s = JSON.parse(readFileSync(sessionFile(), "utf8")) as Session;
  if (s.transport === "cloud") {
    const config = loadConfig();
    if (!config.loggedIn || !config.token || s.endpoint !== `${apiUrl()}/api/memory/team`) return null;
    s.token = config.token;
  }
  if (!s.endpoint || !s.token || !s.identity?.actor) throw new Error("Invalid team session; log in again");
  return s;
}
function binding(root: string): Binding | null {
  return existsSync(bindingFile(root)) ? JSON.parse(readFileSync(bindingFile(root), "utf8")) : null;
}
async function request(s: Pick<Session, "endpoint" | "token" | "transport">, body: object): Promise<any> {
  const url = new URL(s.endpoint);
  const expectedPath = s.transport === "cloud" ? "/api/memory/team" : "/v2/team";
  if (url.username || url.password || url.search || url.hash || url.pathname !== expectedPath || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Invalid team endpoint; HTTPS required outside loopback");
  const response = await policyFetch(url, { method: "POST", signal: AbortSignal.timeout(2500), headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, protocol: 2 }) }, s.transport ?? "engine");
  if (!response.ok) throw new Error(`team_http_${response.status}`);
  const raw = await response.text(); if (raw.length > 2_000_000) throw new Error("Team response too large");
  const result = JSON.parse(raw);
  if (result.protocol !== 2) throw new Error("Invalid team protocol");
  return result;
}
export async function loginTeam(endpoint: string, token: string): Promise<TeamIdentity> {
  if (!token || token.length < 24) throw new Error("A personal team token of at least 24 characters is required");
  const identity = await request({ endpoint, token }, { action: "identity" }) as TeamIdentity;
  if (!identity.actor || !Array.isArray(identity.grants) || !Number.isFinite(Date.parse(identity.expires_at)) || Date.parse(identity.expires_at) <= Date.now()) throw new Error("Invalid authenticated identity");
  atomic(sessionFile(), { endpoint, token, identity }); return identity;
}
/** Reuse the website device-flow credential; do not create or copy a second personal token. */
export async function connectWebTeam(): Promise<TeamIdentity> {
  const config = loadConfig();
  if (!config.loggedIn || !config.token) throw new Error("Sign in with kurtel login first");
  const endpoint = `${apiUrl()}/api/memory/team`;
  const identity = await request({ endpoint, token: config.token, transport: "cloud" }, { action: "identity" }) as TeamIdentity;
  if (!identity.actor || !Array.isArray(identity.grants) || !Number.isFinite(Date.parse(identity.expires_at)) || Date.parse(identity.expires_at) <= Date.now()) throw new Error("Invalid web team identity");
  atomic(sessionFile(), { endpoint, identity, transport: "cloud" });
  return identity;
}
export function logoutTeam(): boolean {
  if (!existsSync(sessionFile())) return false;
  unlinkSync(sessionFile()); return true;
}
/** Historical capture attribution only; cached roles never authorize a network operation. */
export function captureIdentity(root: string): { actor: string; role: string; authenticated_at_login: true } | null {
  try {
    const s = session(), b = binding(root);
    if (!s || !b || b.endpoint !== s.endpoint || Date.parse(s.identity.expires_at) <= Date.now()) return null;
    const grant = s.identity.grants.find(g => g.team === b.team && g.repo === b.repo);
    return grant ? { actor: s.identity.actor, role: grant.role, authenticated_at_login: true } : null;
  } catch { return null; }
}
export async function bindTeam(root: string, team: string, repo: string): Promise<void> {
  if (!session()) await connectWebTeam();
  const s = session(); if (!s) throw new Error("Use kurtel login first");
  await request(s, { action: "sync", team, repo, since: 0 });
  installTeamGuidance(root);
  atomic(bindingFile(root), { endpoint: s.endpoint, team, repo });
}
export function unbindTeam(root: string): void { if (existsSync(bindingFile(root))) unlinkSync(bindingFile(root)); removeTeamGuidance(root); }
export async function teamOperation(root: string, body: object): Promise<any> {
  const s = session(), b = binding(root);
  if (!s || !b || s.endpoint !== b.endpoint) throw new Error("Team not connected for this repository");
  const result = await request(s, { ...body, team: b.team, repo: b.repo });
  if (JSON.stringify(session()) !== JSON.stringify(s) || JSON.stringify(binding(root)) !== JSON.stringify(b)) throw new Error("Team identity or repository changed during request");
  return result;
}
export async function teamWhoami(): Promise<TeamIdentity | null> {
  const s = session(); return s ? request(s, { action: "identity" }) : null;
}

/** An export for review, not a sync of the private store. No captures, source quotes or local paths. */
export function preparePublication(root: string, versionId: string): Publication {
  const store = readKnowledge(root), v = store.versions.find(v => v.id === versionId);
  if (!v || !["lesson", "decision"].includes(v.kind) || v.state !== "active" || store.versions.some(x => x.knowledge_id === v.knowledge_id && x.version > v.version) || (v.valid_until && Date.parse(v.valid_until) <= Date.now())) throw new Error("Only a current active lesson or decision can be prepared");
  if (v.lesson && v.lesson.author !== localIdentity()) throw new Error("Only the local author can prepare this private lesson");
  return {
    id: digest(v.knowledge_id), expected_version: 0, kind: v.kind as "lesson" | "decision", content: v.content, files: v.zones,
    evidence: [{ kind: "document", reference: `reviewed-memory:${digest(v.id)}`, summary: "", revision: null }],
    reason: "", expires_in_days: 90,
  };
}
export async function teamContext(root: string, paths: string[], mode: string, preEdit: boolean): Promise<{ items: ContextItem[]; revision: string }> {
  if (!binding(root)) return { items: [], revision: "none" };
  const result = await teamOperation(root, { action: "context", paths, mode, pre_edit: preEdit });
  if (!Array.isArray(result.records) || result.records.length > 4 || typeof result.revision !== "string") throw new Error("Invalid team context");
  const b = binding(root)!;
  const items = result.records.map((r: TeamRecord) => {
    const v = r.batch?.versions?.[0];
    if (r.team !== b.team || r.repo !== b.repo || !["lesson", "decision"].includes(r.kind) || !v || typeof v.content !== "string" || v.content.length > 600 || !Array.isArray(v.zones) || !v.zones.some(z => paths.includes(z)) || !Number.isFinite(Date.parse(r.expires_at)) || Date.parse(r.expires_at) <= Date.now()) throw new Error("Invalid team record");
    const approval = r.batch.events?.find(e => e.kind === "acceptance")?.content;
    const evidence = r.batch.sources?.[0];
    const text = `- Team ${r.kind} (active, explicitly approved for this repository): ${v.content}\n  Applies to ${v.zones.join(", ")}. Published by ${r.author}; promoted by ${r.promoted_by} (${r.promoter_role}). Approval applies to this scoped engineering guidance; it is not independent proof of general correctness. Shared memory ${r.id} v${r.version}.\n  Approval reason: ${approval?.slice(0, 600) ?? "Consult history"}.\n  Reviewed evidence: ${evidence?.content?.slice(0, 600) ?? "Consult history"}. Reference: ${evidence?.reference ?? "unavailable"}.\n  Inspect get_team_history with this ID if applicability or approval is unclear; missing code precedent alone does not contradict an approved convention.`;
    return { key: `team:${digest(JSON.stringify([b.endpoint, b.team, b.repo, r.id, r.version]))}`, text, files: v.zones, priority: r.kind === "lesson" ? 66 : 55 };
  });
  return { items, revision: result.revision };
}
