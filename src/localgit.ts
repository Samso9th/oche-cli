/** The working copy: branch, changes, commit, push. Thin wrappers over the git binary. */
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export async function git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { maxBuffer: MAX_BUFFER, env: env ? { ...process.env, ...env } : process.env });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new CliError("git isn't installed.");
    throw new CliError(`git ${args[0]} failed: ${(err.stderr ?? err.message).trim()}`);
  }
}

export async function currentBranch(): Promise<string> {
  // symbolic-ref works before the first commit too, unlike rev-parse.
  const name = (await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
  if (!name) throw new CliError("You're on a detached HEAD. Switch to a branch first.");
  return name;
}

export interface Change {
  code: string; // two-letter porcelain status, e.g. " M", "A ", "??"
  path: string;
}

/** Everything that differs from HEAD, including untracked files (respecting .gitignore). */
export async function changes(): Promise<Change[]> {
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = out.split("\0").filter(Boolean);
  const list: Change[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const code = e.slice(0, 2);
    list.push({ code, path: e.slice(3) });
    if (code[0] === "R" || code[0] === "C") i++; // renames carry the old path as the next entry
  }
  return list;
}

export async function stagedDiff(maxChars = 60_000): Promise<{ diff: string; stat: string }> {
  const [diff, stat] = await Promise.all([git(["diff", "--cached", "--no-color"]), git(["diff", "--cached", "--stat", "--no-color"])]);
  return { diff: diff.length > maxChars ? `${diff.slice(0, maxChars)}\n[diff truncated]` : diff, stat };
}

/**
 * The diff `git add -A` would produce, computed on a throwaway copy of the
 * index so the real staging area isn't touched until the user says yes.
 */
export async function previewAddAll(maxChars = 60_000): Promise<{ diff: string; stat: string }> {
  const indexPath = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const dir = await mkdtemp(join(tmpdir(), "oche-index-"));
  const tmpIndex = join(dir, "index");
  try {
    await copyFile(indexPath, tmpIndex).catch(() => {}); // a fresh repo may not have an index yet
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(["add", "-A"], env);
    const [diff, stat] = await Promise.all([
      git(["diff", "--cached", "--no-color"], env),
      git(["diff", "--cached", "--stat", "--no-color"], env),
    ]);
    return { diff: diff.length > maxChars ? `${diff.slice(0, maxChars)}\n[diff truncated]` : diff, stat };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function recentSubjects(n = 10): Promise<string[]> {
  try {
    return (await git(["log", `-${n}`, "--format=%s"])).split("\n").filter(Boolean);
  } catch {
    return []; // no commits yet
  }
}

export const addAll = () => git(["add", "-A"]);
export const addTracked = () => git(["add", "-u"]);
export const commit = (message: string) => git(["commit", "-m", message]);

/** `git commit -e -m msg`: opens the user's editor with the message prefilled. */
export function commitWithEditor(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["commit", "-e", "-m", message], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new CliError("Commit aborted."))));
  });
}

/** Commits on this branch that aren't on its upstream yet. Null when there's no upstream. */
export async function unpushed(): Promise<number | null> {
  try {
    return Number((await git(["rev-list", "--count", "@{u}..HEAD"])).trim());
  } catch {
    return null;
  }
}

export const push = (branch: string) => git(["push", "--set-upstream", "origin", branch]);

export const fetchBranch = (branch: string) => git(["fetch", "--quiet", "origin", branch]);

/** Subjects of commits on HEAD that aren't on origin/<base>, newest first. Run fetchBranch(base) first. */
export async function subjectsAhead(base: string): Promise<string[]> {
  return (await git(["log", `origin/${base}..HEAD`, "--format=%s"])).split("\n").filter(Boolean);
}
