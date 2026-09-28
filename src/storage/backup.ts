import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, emptyBatch, knowledgePath, knowledgeScope, readKnowledge } from "./knowledge.js";
import { validateKnowledge } from "./knowledge-validation.js";

interface Backup { format: "kurtel-knowledge-backup-v1"; scope: string; files: Record<string, { sha256: string; content: string }> }
const captureName = /^sessions\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/;
const maxBytes = 64 * 1024 * 1024;
function filesUnder(dir: string, prefix = ""): Record<string, string> {
  const output: Record<string, string> = {};
  if (!existsSync(dir)) return output;
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Backup refuses symbolic links");
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), entry = prefix + name, stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Backup refuses symbolic links");
    if (name.endsWith(".lock")) throw new Error("Stop Kurtel writers before backing up");
    if (stat.isDirectory()) Object.assign(output, filesUnder(path, entry + "/"));
    else if (entry === "store.json" || captureName.test(entry)) {
      if (stat.size > maxBytes) throw new Error("Backup file exceeds 64 MiB");
      output[entry] = readFileSync(path, "utf8");
    }
  }
  return output;
}
function validate(backup: Backup) {
  if (backup?.format !== "kurtel-knowledge-backup-v1" || !/^[a-f0-9]{64}$/.test(backup.scope) || !backup.files || Array.isArray(backup.files) || !Object.hasOwn(backup.files, "store.json")) throw new Error("Invalid knowledge backup");
  for (const [name, file] of Object.entries(backup.files)) {
    if (name !== "store.json" && !captureName.test(name)) throw new Error("Unexpected backup path");
    if (!file || typeof file.content !== "string" || digest(file.content) !== file.sha256) throw new Error("Backup checksum mismatch");
    const data = JSON.parse(file.content);
    if (name === "store.json") validateKnowledge(data, backup.scope);
    else {
      validateKnowledge({ schema_version: 2, scope: backup.scope, revision: 0, ...emptyBatch(), sources: [data.source], events: [data.event] }, backup.scope);
      const [, sessionHash, filename] = name.split("/");
      const id = filename.slice(0, -5);
      if (typeof data.event.session_id !== "string" || digest(data.event.session_id) !== sessionHash || data.source.id !== `capture:${id}` || data.event.id !== `capture-event:${id}` || data.event.source_ids.length !== 1 || data.event.source_ids[0] !== data.source.id) throw new Error("Invalid captured event identity");
    }
  }
}
export function backupKnowledge(root: string, destination: string) {
  const dir = dirname(knowledgePath(root)), output = resolve(destination), rel = relative(dir, output);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Write the backup outside its source directory");
  const files = filesUnder(dir);
  if (!files["store.json"]) files["store.json"] = JSON.stringify(readKnowledge(root));
  const second = filesUnder(dir); if (!second["store.json"]) second["store.json"] = JSON.stringify(readKnowledge(root));
  if (JSON.stringify(files) !== JSON.stringify(second)) throw new Error("Knowledge changed during backup; stop writers and retry");
  const backup: Backup = { format: "kurtel-knowledge-backup-v1", scope: knowledgeScope(root), files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content, sha256: digest(content) }])) };
  validate(backup);
  const text = JSON.stringify(backup);
  if (Buffer.byteLength(text) > maxBytes) throw new Error("Backup exceeds 64 MiB; use an offline filesystem backup");
  writeFileSync(output, text + "\n", { mode: 0o600, flag: "wx" });
  return { path: output, files: Object.keys(files).length };
}
export function restoreKnowledge(root: string, source: string, relocate = false) {
  if (lstatSync(source).size > maxBytes + 1) throw new Error("Backup exceeds 64 MiB");
  const backup: Backup = JSON.parse(readFileSync(source, "utf8")); validate(backup);
  const scope = knowledgeScope(root);
  if (scope !== backup.scope && !relocate) throw new Error("Different repository path: review the destination and use --relocate explicitly");
  const target = dirname(knowledgePath(root));
  if (existsSync(target)) throw new Error("Restore requires an empty knowledge destination; existing data is never overwritten");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const stage = `${target}.restore-${randomUUID()}`; mkdirSync(stage, { mode: 0o700 });
  for (const [name, file] of Object.entries(backup.files)) {
    const path = join(stage, name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const content = name === "store.json" ? JSON.stringify({ ...JSON.parse(file.content), scope }) : file.content;
    writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  }
  // Configuration/credentials are intentionally absent; capture and extraction remain off.
  if (existsSync(target)) throw new Error("Knowledge destination changed during restore");
  renameSync(stage, target);
  return { path: target, files: Object.keys(backup.files).length, capture_enabled: false, extraction_enabled: false };
}
