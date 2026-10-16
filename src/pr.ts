/**
 * `oche pr`: commit what's changed with an AI message, push the work branch,
 * and open a PR into dev (or develop), optionally merging it. Runs entirely
 * from your machine: OpenRouter for the message, your own GitHub token for the
 * PR. No Oche server involved.
 */
import { CliError } from "./errors.ts";
import { inferRepo, slug } from "./git.ts";
import { GitHub, githubToken, type MergeMethod, type PullRequest } from "./github.ts";
import { loadLocalConfig, resolveAi } from "./local-config.ts";
import { addAll, changes, commit, currentBranch, fetchBranch, previewAddAll, push, recentSubjects, subjectsAhead, unpushed } from "./localgit.ts";
import { generateCommitMessage } from "./openrouter.ts";
import { choose, describeChange } from "./ship.ts";
import { ask, c, closeReader, isInteractive, ok, plural, print, printJson, warn } from "./ui.ts";
import type { CommitMessageRequest } from "./api-types.ts";

/** Long-lived branches: `oche pr` only ships work branches. */
export const PROTECTED = new Set(["main", "master", "staging", "dev", "develop"]);
const BASE_CANDIDATES = ["dev", "develop"];

export interface PrOptions {
  base?: string;
  merge?: boolean;
  squash?: boolean;
  rebase?: boolean;
  deleteBranch?: boolean;
  draft?: boolean;
  title?: string;
  message?: string;
  yes?: boolean;
  /** Only show the plan (with the AI message); change nothing. */
  dryRun?: boolean;
  /** Machine-readable output on stdout, progress on stderr. Used by the VS Code extension. */
  json?: boolean;
}

/** What `oche pr --dry-run --json` prints. Mirrored in vscode/src/cli.ts: keep in sync. */
export interface PrPlan {
  repo: string;
  branch: string;
  base: string;
  message: string | null;
  files: { code: string; path: string }[];
  /** Commits not on GitHub yet; null when the branch isn't published. */
  unpushed: number | null;
  existingPr: { number: number; url: string } | null;
}

/** What `oche pr --yes --json` prints when it finishes. */
export interface PrResult {
  committed: boolean;
  pr: { number: number; url: string; created: boolean };
  merged: boolean;
  base: string;
  branch: string;
}

/** "feature/login-page" → "Login page" */
export function titleFromBranch(branch: string): string {
  const words = branch.replace(/^[^/]+\//, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : branch;
}

export function prTitle(subjects: string[], branch: string): string {
  return subjects.length === 1 ? subjects[0]! : titleFromBranch(branch);
}

export function prBody(subjects: string[]): string {
  if (!subjects.length) return "";
  // Oldest first reads like a changelog.
  return `${[...subjects].reverse().map((s) => `- ${s}`).join("\n")}\n\n<sub>Opened with \`oche pr\`.</sub>`;
}

function mergeMethod(opts: PrOptions): MergeMethod {
  if (opts.squash && opts.rebase) throw new CliError("Pick one of --squash or --rebase.");
  return opts.squash ? "squash" : opts.rebase ? "rebase" : "merge";
}

async function writeMessage(input: CommitMessageRequest): Promise<string> {
  const ai = resolveAi(await loadLocalConfig(), process.env);
  if (!ai.key) throw new CliError("No OpenRouter key. Run `oche ai-key` (or set OPENROUTER_API_KEY), or pass -m \"message\".");
  process.stderr.write(c.dim(`Writing a commit message with ${ai.model}…\n`));
  return generateCommitMessage(input, { apiKey: ai.key, model: ai.model });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GitHub works out mergeability in the background, so a fresh PR reports null for a moment. */
async function waitForMergeable(gh: GitHub, repo: Parameters<GitHub["pull"]>[0], n: number): Promise<PullRequest> {
  let pr = await gh.pull(repo, n);
  for (let i = 0; pr.mergeable === null && i < 10; i++) {
    await sleep(1_500);
    pr = await gh.pull(repo, n);
  }
  return pr;
}

export async function prCommand(opts: PrOptions) {
  const method = opts.merge ? mergeMethod(opts) : null;
  if (opts.draft && opts.merge) throw new CliError("A draft PR can't be merged. Drop --draft or --merge.");
  if (opts.deleteBranch && !opts.merge) throw new CliError("--delete-branch only applies with --merge.");
  if (opts.json && !opts.yes && !opts.dryRun) throw new CliError("--json needs --yes or --dry-run.");
  // With --json, stdout carries only the final JSON.
  const done = opts.json ? (m: string) => void process.stderr.write(`✓ ${m}\n`) : ok;

  const [repo, branch, changed] = await Promise.all([inferRepo(), currentBranch(), changes()]);
  if (PROTECTED.has(branch)) {
    throw new CliError(`You're on ${branch}. \`oche pr\` ships work branches; create one with \`git switch -c feature/<name>\`.`);
  }

  const gh = new GitHub(await githubToken());
  const base = opts.base ?? (await gh.firstBranch(repo, BASE_CANDIDATES));
  if (!base) throw new CliError(`${slug(repo)} has no dev or develop branch on GitHub (or your GitHub token can't see the repo). Pass --base <branch>.`);
  if (base === branch) throw new CliError(`You're on ${base}, the branch the PR would go into.`);

  // Everything that will happen, before anything happens.
  let message: string | null = null;
  let input: CommitMessageRequest | null = null;
  if (changed.length) {
    input = { ...(await previewAddAll()), recent: await recentSubjects(), branch };
    message = opts.message ?? (await writeMessage(input));
  }
  const [behind, existing] = await Promise.all([unpushed(), gh.openPull(repo, branch, base)]);

  if (opts.dryRun && opts.json) {
    return printJson({
      repo: slug(repo),
      branch,
      base,
      message,
      files: changed,
      unpushed: behind,
      existingPr: existing ? { number: existing.number, url: existing.html_url } : null,
    } satisfies PrPlan);
  }

  for (;;) {
    if (opts.json) break;
    print(`${c.bold(`${branch} → ${base}`)}  ${c.dim(slug(repo))}`);
    print("");
    let n = 1;
    if (message) {
      print(`  ${n++}. Commit ${plural(changed.length, "file")}:`);
      for (const line of message.split("\n")) print(`       ${line ? c.bold(line) : ""}`);
      for (const ch of changed.slice(0, 12)) print(`       ${describeChange(ch)}`);
      if (changed.length > 12) print(c.dim(`       …and ${changed.length - 12} more`));
    }
    print(`  ${n++}. Push ${branch}${behind === null ? c.dim("  (publishes it to GitHub)") : behind > 0 ? c.dim(`  (${plural(behind, "commit")} not pushed yet)`) : ""}`);
    print(`  ${n++}. ${existing ? `Update PR #${existing.number} ${c.dim("(already open)")}` : `Open a ${opts.draft ? "draft " : ""}PR into ${base}`}`);
    if (method) print(`  ${n++}. Merge it into ${base} ${c.dim(`(${method}${opts.deleteBranch ? ", then delete the branch on GitHub" : ""})`)}`);
    print("");

    if (opts.dryRun) return;
    if (opts.yes) break;
    if (!isInteractive()) throw new CliError("This needs confirmation. Run it in a terminal, or pass --yes.");
    const choice = await choose(method ? "Commit, push and merge?" : "Commit, push and open the PR?", Boolean(message && !opts.message));
    if (choice === "no") return print("Nothing done.");
    if (choice === "rewrite" && input) {
      message = await writeMessage(input);
      continue;
    }
    if (choice === "edit" && message) {
      const edited = await ask("Message (one line; use `oche commit` for a longer one)", message.split("\n")[0]);
      message = edited.trim() || message;
      continue;
    }
    break;
  }
  closeReader();

  // Go.
  if (message) {
    await addAll();
    await commit(message);
    done("Committed");
  }
  process.stderr.write(c.dim(`Pushing ${branch}…\n`));
  await push(branch);
  done(`Pushed ${branch}`);

  let pr = existing;
  if (!pr) {
    await fetchBranch(base);
    const subjects = await subjectsAhead(base);
    if (!subjects.length) throw new CliError(`${branch} has nothing that isn't already on ${base}, so there's no PR to open.`);
    pr = await gh.createPull(repo, {
      head: branch,
      base,
      title: opts.title ?? prTitle(subjects, branch),
      body: prBody(subjects),
      draft: opts.draft,
    });
    done(`Opened PR #${pr.number}  ${c.cyan(pr.html_url)}`);
  } else {
    done(`PR #${pr.number} has the new commits  ${c.cyan(pr.html_url)}`);
  }

  const result = (merged: boolean): PrResult => ({
    committed: Boolean(message),
    pr: { number: pr!.number, url: pr!.html_url, created: !existing },
    merged,
    base,
    branch,
  });
  if (!method) return opts.json ? printJson(result(false)) : undefined;
  if (pr.draft) throw new CliError(`PR #${pr.number} is a draft. Mark it ready for review on GitHub, then run \`oche pr --merge\` again.`);

  process.stderr.write(c.dim("Checking it can merge…\n"));
  pr = await waitForMergeable(gh, repo, pr.number);
  if (pr.mergeable === false) {
    throw new CliError(`PR #${pr.number} conflicts with ${base}. Merge ${base} into ${branch}, fix the conflicts, then run \`oche pr --merge\` again.`);
  }
  if (pr.mergeable === null) warn("GitHub hasn't finished checking mergeability; trying the merge anyway.");
  await gh.merge(repo, pr.number, method);
  done(`Merged #${pr.number} into ${base}`);

  if (opts.deleteBranch) {
    await gh.deleteBranch(repo, branch);
    done(`Deleted ${branch} on GitHub`);
  }
  if (opts.json) return printJson(result(true));
  print(c.dim(`\nYou're still on ${branch}. \`git switch ${base} && git pull\` to carry on from ${base}.`));
}
