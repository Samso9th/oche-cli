import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";

export interface RepoSlug {
  owner: string;
  repo: string;
}

export const slug = (r: RepoSlug) => `${r.owner}/${r.repo}`;

/** github.com, plus ssh.github.com (port 443) and ~/.ssh/config aliases like github.com-work. */
const GITHUB_HOST = /^(?:www\.|ssh\.)?github\.com(?:-[\w.-]+)?$/i;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const URL_SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);

function toSlug(path: string): RepoSlug | null {
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/**
 * Reads owner/repo out of a GitHub remote URL:
 *   https://github.com/o/r(.git)   git@github.com:o/r.git   ssh://git@github.com/o/r.git
 * Returns null for anything that isn't a github.com repo.
 */
export function parseGitHubRemote(remote: string): RepoSlug | null {
  const s = remote.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (!URL_SCHEMES.has(u.protocol)) return null;
    host = u.hostname;
    path = decodeURIComponent(u.pathname);
  } else {
    // scp-like: [user@]host:owner/repo.git
    const m = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(s);
    if (!m) return null;
    host = m[1]!;
    path = m[2]!;
  }
  if (!GITHUB_HOST.test(host)) return null;
  return toSlug(path);
}

/** Accepts "owner/repo" or a GitHub URL. */
export function parseRepoArg(arg: string): RepoSlug {
  const s = arg.trim();
  const found = /^[^/\s:@]+\/[^/\s:@]+$/.test(s) ? toSlug(s) : parseGitHubRemote(s);
  if (!found) throw new CliError(`Expected owner/repo, got "${arg}".`);
  return found;
}

const run = promisify(execFile);

export async function inferRepo(cwd = process.cwd()): Promise<RepoSlug> {
  let url: string;
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd });
    url = stdout.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError("git isn't installed, so the repo can't be inferred. Pass owner/repo.");
    }
    throw new CliError("No repo given and no git remote \"origin\" here. Pass owner/repo.");
  }
  const found = parseGitHubRemote(url);
  if (!found) throw new CliError(`origin (${url}) isn't a GitHub repo. Pass owner/repo.`);
  return found;
}

export async function resolveRepo(arg: string | undefined): Promise<RepoSlug> {
  return arg ? parseRepoArg(arg) : inferRepo();
}
