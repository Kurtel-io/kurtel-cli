import { isAbsolute, relative, resolve } from "node:path";
import type { Source } from "../domain/knowledge.js";

// Facts about a tool call (files, command, exit status), kept after the capture text is erased.
export interface ToolObservation {
  tool: string;
  targets: string[];
  command?: string;
  exit_code?: number;
  failed: boolean;
  // Outside this repository: the turn is not learned from.
  outside?: boolean;
}
export interface PriorHint { source: Source; files: string[] }

export function repositoryTarget(root: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) return;
  const path = value.replace(/\\/g, "/");
  const local = relative(resolve(root), isAbsolute(path) ? path : resolve(root, path)).replace(/\\/g, "/");
  if (!local || local === ".." || local.startsWith("../") || isAbsolute(local)) return;
  return local;
}

/** Only a structured exit status counts, not stdout. */
export function observeTool(root: string, tool: string, input: Record<string, unknown>, response: unknown, failed: boolean): ToolObservation {
  const paths: unknown[] = [input.file_path, input.path];
  if (tool === "apply_patch") {
    const patch = input.patch ?? input.input ?? input.command;
    if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)) paths.push(match[1].trim());
  }
  const result = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const exit = result.exit_code ?? result.exitCode;
  const command = input.command ?? input.cmd;
  const outside = paths.some(p => typeof p === "string" && p.trim() !== "" && p.length <= 1000 && !repositoryTarget(root, p) && resolve(root, p.replace(/\\/g, "/")) !== resolve(root));
  return {
    tool, targets: [...new Set(paths.map(p => repositoryTarget(root, p)).filter((p): p is string => !!p))].slice(0, 32),
    ...(outside ? { outside: true } : {}),
    ...(typeof command === "string" && command.length <= 2000 && tool !== "apply_patch" ? { command } : {}),
    ...(Number.isSafeInteger(exit) ? { exit_code: exit as number } : {}),
    failed: failed || result.is_error === true || result.isError === true || (typeof exit === "number" && exit !== 0),
  };
}

export function verificationCommand(command?: string): boolean {
  if (!command || /[\n\r;&|`<>]/.test(command) || /\$\(/.test(command)) return false;
  return /^(?:(?:npm|pnpm|yarn) (?:run )?(?:test(?::[\w-]+)?|build|typecheck)|(?:npx )?(?:vitest|jest|tsc)|(?:python(?:3)? -m )?pytest|cargo (?:test|build|check)|go test|dotnet (?:test|build))(?:\s|$)/.test(command.trim())
    && !/\b(?:watch|help|version|listTests|list|collect-only)\b|--noEmit false/.test(command);
}
