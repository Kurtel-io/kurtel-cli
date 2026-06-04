import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

export interface KurtelConfig {
  engine: string;
  defaultBranch: string;
  loggedIn: boolean;
  account?: string;
  [key: string]: unknown;
}

const DIR = join(homedir(), ".kurtel");
const FILE = join(DIR, "config.json");

const DEFAULTS: KurtelConfig = {
  engine: "kurtel-sota (codex + claude-code)",
  defaultBranch: "main",
  loggedIn: false,
};

export function configPath(): string {
  return FILE;
}

export function loadConfig(): KurtelConfig {
  try {
    if (!existsSync(FILE)) return { ...DEFAULTS };
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: KurtelConfig): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function setConfigValue(key: string, value: unknown): KurtelConfig {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
  return config;
}
