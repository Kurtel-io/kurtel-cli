import { networkPolicy } from "../security/network.js";
import { knowledgeScope } from "./knowledge.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { repoSlug } from "../repository/git.js";

export function cacheDir(root: string): string {
  return join(homedir(), ".kurtel", "cache", networkPolicy().mode === "cloud" ? repoSlug(root) : knowledgeScope(root));
}

export function indexPath(root: string): string {
  return join(root, ".kurtel", "index.json");
}

export function reportPath(root: string): string {
  return join(root, ".kurtel", "REPORT.md");
}

export function injectionLogPath(root: string): string {
  return join(root, ".kurtel", "injection-log.md");
}

export function injectedIdsPath(root: string): string {
  return join(root, ".kurtel", "injected.jsonl");
}

export function vectorsPathsIn(dir: string): { bin: string; vocab: string } {
  return { bin: join(dir, "vectors.bin"), vocab: join(dir, "vocab.txt") };
}

export function userVectorsDir(): string {
  return join(homedir(), ".kurtel", "vectors");
}

// src/storage and dist/storage have the same depth relative to assets.
function bundledVectorsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "vectors");
}

export function vectorsReadPaths(): { bin: string; vocab: string } {
  const user = vectorsPathsIn(userVectorsDir());
  if (existsSync(user.bin) && existsSync(user.vocab)) return user;
  return vectorsPathsIn(bundledVectorsDir());
}

export function embeddingsPaths(root: string): { bin: string; meta: string } {
  const d = cacheDir(root);
  return { bin: join(d, "embeddings.bin"), meta: join(d, "embeddings.json") };
}

export function statePath(root: string): string {
  return join(cacheDir(root), "state.json");
}

export function projectConfigPath(root: string): string {
  return join(root, ".kurtel", "config.json");
}
