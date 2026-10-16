/**
 * Settings for the commands that run without an Oche server (`oche pr`):
 * the OpenRouter key and model. Kept apart from config.json, which holds the
 * server login.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath } from "./config.ts";
import { CliError } from "./errors.ts";

export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

export interface LocalConfig {
  openrouterKey?: string;
  model?: string;
}

type Env = Record<string, string | undefined>;

export const localConfigPath = (env: Env = process.env) => join(dirname(configPath(env)), "local.json");

export async function loadLocalConfig(path = localConfigPath()): Promise<LocalConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(`Couldn't read ${path}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as LocalConfig;
    return {
      openrouterKey: typeof parsed.openrouterKey === "string" ? parsed.openrouterKey : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  } catch {
    throw new CliError(`${path} is not valid JSON. Delete it or run \`oche ai-key\` again.`);
  }
}

export async function saveLocalConfig(cfg: LocalConfig, path = localConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Environment beats the file: OPENROUTER_API_KEY and OCHE_AI_MODEL. */
export function resolveAi(file: LocalConfig, env: Env): { key: string | null; model: string } {
  return {
    key: env.OPENROUTER_API_KEY?.trim() || file.openrouterKey?.trim() || null,
    model: env.OCHE_AI_MODEL?.trim() || file.model?.trim() || DEFAULT_MODEL,
  };
}
