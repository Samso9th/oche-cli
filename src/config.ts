import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";

export interface StoredConfig {
  url: string;
  token: string;
  /** Who the token belongs to, for display only. */
  login?: string;
}

export type Source = "env" | "config" | "none";

export interface ResolvedConfig {
  url: string | null;
  token: string | null;
  urlSource: Source;
  tokenSource: Source;
}

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "oche", "config.json");
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

/** "deploy.oche.io/" → "https://deploy.oche.io". Keeps a sub-path if there is one. */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new CliError("Server URL is empty.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${LOCAL_HOST.test(s) ? "http" : "https"}://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new CliError(`"${input}" is not a valid URL.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new CliError(`"${input}" must be an http(s) URL.`);
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * Environment beats the config file, field by field. A saved token is only
 * used for the server it was saved for, so pointing OCHE_URL somewhere else
 * never sends that token to a different host.
 */
export function resolveConfig(file: Partial<StoredConfig> | null, env: Env): ResolvedConfig {
  const envUrl = env.OCHE_URL?.trim() || null;
  const envToken = env.OCHE_TOKEN?.trim() || null;
  const fileUrl = file?.url ? safeNormalize(file.url) : null;
  const fileToken = file?.token?.trim() || null;

  const url = envUrl ? normalizeUrl(envUrl) : fileUrl;
  const urlSource: Source = envUrl ? "env" : fileUrl ? "config" : "none";

  let token: string | null = null;
  let tokenSource: Source = "none";
  if (envToken) {
    token = envToken;
    tokenSource = "env";
  } else if (fileToken && url && url === fileUrl) {
    token = fileToken;
    tokenSource = "config";
  }
  return { url, token, urlSource, tokenSource };
}

function safeNormalize(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

export async function loadConfig(path = configPath()): Promise<StoredConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`Couldn't read ${path}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return null;
    return { url: parsed.url, token: parsed.token, login: parsed.login };
  } catch {
    throw new CliError(`${path} is not valid JSON. Delete it or run \`oche login\` again.`);
  }
}

export async function saveConfig(cfg: StoredConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies when it creates the file.
  await chmod(path, 0o600);
}

export async function deleteConfig(path = configPath()): Promise<boolean> {
  const existed = (await loadConfig(path).catch(() => ({}))) !== null;
  await rm(path, { force: true });
  return existed;
}
