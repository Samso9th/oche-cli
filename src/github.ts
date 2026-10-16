/**
 * Just enough of the GitHub REST API for `oche pr`, called with your own
 * GitHub token (GH_TOKEN, GITHUB_TOKEN, or the one `gh auth login` saved).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";
import { slug, type RepoSlug } from "./git.ts";

const API = "https://api.github.com";
const run = promisify(execFile);

export async function githubToken(env: Record<string, string | undefined> = process.env): Promise<string> {
  const fromEnv = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await run("gh", ["auth", "token"]);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // gh missing or logged out: fall through to the hint.
  }
  throw new CliError("No GitHub token. Run `gh auth login`, or set GH_TOKEN to a token with repo access.");
}

export interface PullRequest {
  number: number;
  html_url: string;
  title: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The first of `names` that exists on GitHub, in order. */
  async firstBranch(r: RepoSlug, names: string[]): Promise<string | null> {
    for (const name of names) {
      const res = await this.raw("GET", `/repos/${slug(r)}/branches/${encodeURIComponent(name)}`);
      if (res.ok) return name;
      if (res.status !== 404) await this.fail(res, `look up ${name}`);
    }
    return null;
  }

  async openPull(r: RepoSlug, head: string, base: string): Promise<PullRequest | null> {
    const q = new URLSearchParams({ state: "open", head: `${r.owner}:${head}`, base });
    const list = await this.json<PullRequest[]>("GET", `/repos/${slug(r)}/pulls?${q}`, undefined, "list pull requests");
    return list[0] ?? null;
  }

  async createPull(r: RepoSlug, body: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequest> {
    return this.json<PullRequest>("POST", `/repos/${slug(r)}/pulls`, body, "open the pull request");
  }

  async pull(r: RepoSlug, n: number): Promise<PullRequest> {
    return this.json<PullRequest>("GET", `/repos/${slug(r)}/pulls/${n}`, undefined, `read PR #${n}`);
  }

  async merge(r: RepoSlug, n: number, method: MergeMethod): Promise<void> {
    await this.json("PUT", `/repos/${slug(r)}/pulls/${n}/merge`, { merge_method: method }, `merge PR #${n}`);
  }

  async deleteBranch(r: RepoSlug, branch: string): Promise<void> {
    const res = await this.raw("DELETE", `/repos/${slug(r)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
    if (!res.ok && res.status !== 422 && res.status !== 404) await this.fail(res, `delete ${branch}`);
  }

  private async json<T>(method: string, path: string, body: unknown, what: string): Promise<T> {
    const res = await this.raw(method, path, body);
    if (!res.ok) await this.fail(res, what);
    return (await res.json()) as T;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "oche-cli",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new CliError(`Couldn't reach GitHub (${(e as Error).message}).`);
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const data = (await res.json().catch(() => null)) as { message?: string; errors?: { message?: string }[] } | null;
    const detail = [data?.message, ...(data?.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
    if (res.status === 401) throw new CliError("GitHub rejected your token. Run `gh auth login` again, or check GH_TOKEN.");
    if (res.status === 404) throw new CliError(`Couldn't ${what}: GitHub says not found. Does your token have access to this repo?`);
    throw new CliError(`Couldn't ${what} (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`);
  }
}
