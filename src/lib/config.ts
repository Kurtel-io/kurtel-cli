import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

export interface KurtelConfig {
  loggedIn: boolean;
  account?: string;
  organization?: string;
  token?: string;
  [key: string]: unknown;
}

// KURTEL_API_URL, then "apiUrl" in the config, then kurtel.io.
export function apiUrl(): string {
  const raw =
    process.env.KURTEL_API_URL ??
    (loadConfig().apiUrl as string | undefined) ??
    "https://www.kurtel.io";
  return raw.replace(/\/+$/, "");
}

export function saveSession(session: {
  token: string;
  account?: string | null;
  organization?: string | null;
}): void {
  const config = loadConfig();
  config.loggedIn = true;
  config.token = session.token;
  if (session.account) config.account = session.account;
  if (session.organization) config.organization = session.organization;
  saveConfig(config);
}

export function clearSession(): void {
  const config = loadConfig();
  config.loggedIn = false;
  delete config.token;
  delete config.account;
  delete config.organization;
  saveConfig(config);
}

const DIR = join(homedir(), ".kurtel");
const FILE = join(DIR, "config.json");

const DEFAULTS: KurtelConfig = {
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