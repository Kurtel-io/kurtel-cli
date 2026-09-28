import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { MemoryState } from "../domain/types.js";
import { loadConfig } from "../lib/config.js";
import { statePath, projectConfigPath, reportPath } from "./paths.js";
import { readJSON, writeJSON } from "./json.js";
import { accessGated, accessMemory, activeAccess } from "./access.js";

const EMPTY_STATE: MemoryState = { enabled: true, session_zones: {} };

export function loadMemoryState(root: string): MemoryState {
  return readJSON(statePath(root), EMPTY_STATE);
}

export function saveMemoryState(root: string, state: MemoryState): void {
  const ids = Object.keys(state.session_zones);
  if (ids.length > 20) {
    for (const id of ids.slice(0, ids.length - 20)) delete state.session_zones[id];
  }
  writeJSON(statePath(root), state);
}

/** False after `kurtel off`. */
export function kurtelEnabled(root: string): boolean {
  return loadMemoryState(root).off !== true;
}

export function setKurtelEnabled(root: string, enabled: boolean): void {
  const s = loadMemoryState(root);
  s.off = !enabled;
  saveMemoryState(root, s);
}

/** Memory needs Kurtel on, memory in the organization's plan, and `kurtel memory on`. */
export function memoryEnabled(root: string): boolean {
  if (memoryDisabledGlobally()) return false;
  const state = loadMemoryState(root);
  if (state.off === true || !state.enabled) return false;
  return !accessGated() || accessMemory(root);
}

/** The developer's memory switch alone. */
export function memorySwitchOn(root: string): boolean {
  return !memoryDisabledGlobally() && loadMemoryState(root).enabled;
}

export function setMemoryEnabled(root: string, enabled: boolean): void {
  const s = loadMemoryState(root);
  s.enabled = enabled;
  saveMemoryState(root, s);
}

export function memoryDisabledGlobally(): boolean {
  return loadConfig().memoryDisabled === true;
}

export function repoActivated(root: string): boolean {
  // Markers below: enterprise deployments only.
  if (accessGated()) return activeAccess(root) !== null;
  // ~/.kurtel/config.json is the global config, not a project marker.
  const isHome = resolve(root) === resolve(homedir());
  if (!isHome && existsSync(projectConfigPath(root))) return true;
  // REPORT.md is written only by `kurtel onboard`.
  if (!isHome && existsSync(reportPath(root))) return true;
  return loadMemoryState(root).activated === true;
}

export function activateRepo(root: string): void {
  const s = loadMemoryState(root);
  s.activated = true;
  s.enabled = true;
  saveMemoryState(root, s);
}
