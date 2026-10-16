/**
 * `oche commit`: AI commit message for what's staged.
 * `oche ship`:   commit what's changed, push, and take it up to production with one confirmation.
 */
import type { Client } from "./api.ts";
import type { ApiShipRun, CommitMessageRequest, RunStep, ShipTarget } from "./api-types.ts";
import { ApiRequestError, CliError } from "./errors.ts";
import { resolveRepo } from "./git.ts";
import {
  addAll,
  addTracked,
  changes,
  commit,
  commitWithEditor,
  currentBranch,
  previewAddAll,
  push,
  recentSubjects,
  stagedDiff,
  unpushed,
  type Change,
} from "./localgit.ts";
import { planLines, stepUpdates } from "./ship-run.ts";
import { ask, c, closeReader, isInteractive, ok, plural, print, warn } from "./ui.ts";

type GetClient = () => Promise<Client>;

type MessageInput = CommitMessageRequest;

async function writeMessage(api: Client, input: MessageInput): Promise<string> {
  process.stderr.write(c.dim("Writing a commit message…\n"));
  return (await api.commitMessage(input)).message;
}

export function showMessage(message: string) {
  print("");
  for (const line of message.split("\n")) print(`  ${line ? c.bold(line) : ""}`);
  print("");
}

type Choice = "yes" | "edit" | "rewrite" | "no";

export async function choose(question: string, canRewrite: boolean): Promise<Choice> {
  const keys = canRewrite ? "Y/n · e edit · r rewrite" : "Y/n · e edit";
  for (;;) {
    const a = (await ask(`${question} [${keys}]`, "y")).trim().toLowerCase();
    if (a === "" || a === "y" || a === "yes") return "yes";
    if (a === "n" || a === "no" || a === "q") return "no";
    if (a === "e" || a === "edit") return "edit";
    if (canRewrite && (a === "r" || a === "rewrite")) return "rewrite";
  }
}

/* ------------------------------------------------------------------ */
/* oche commit                                                         */
/* ------------------------------------------------------------------ */

export async function commitCommand(getClient: GetClient, opts: { all?: boolean; yes?: boolean; dryRun?: boolean; message?: string }) {
  if (opts.all) await addTracked();
  const staged = await stagedDiff();
  if (!staged.diff.trim()) throw new CliError("Nothing staged. Stage files with `git add`, or use -a for tracked changes.");

  const input: MessageInput = { ...staged, recent: await recentSubjects(), branch: await currentBranch() };
  const api = opts.message ? null : await getClient();
  let message = opts.message ?? (await writeMessage(api!, input));

  for (;;) {
    showMessage(message);
    if (opts.dryRun) return;
    if (opts.yes || !isInteractive()) break;
    const choice = await choose("Commit with this message?", !opts.message);
    if (choice === "no") return print("Nothing committed.");
    if (choice === "rewrite" && api) {
      message = await writeMessage(api, input);
      continue;
    }
    if (choice === "edit") {
      closeReader();
      await commitWithEditor(message);
      return ok("Committed.");
    }
    break;
  }
  await commit(message);
  ok("Committed.");
}

/* ------------------------------------------------------------------ */
/* oche ship                                                           */
/* ------------------------------------------------------------------ */

const TARGET_LABEL: Record<ShipTarget, string> = { dev: "dev", staging: "staging", prod: "production" };

export function describeChange(ch: Change): string {
  const code = ch.code.trim() || "M";
  const tone = code === "??" || code.includes("A") ? c.green : code.includes("D") ? c.red : c.yellow;
  return `${tone(code === "??" ? "A" : code[0]!)} ${ch.path}`;
}

export async function shipCommand(
  getClient: GetClient,
  targetArg: string | undefined,
  repoArg: string | undefined,
  opts: { direct?: boolean; yes?: boolean; message?: string; cancel?: string },
) {
  if (opts.cancel !== undefined) return cancelCommand(getClient, opts.cancel);
  const target = (targetArg ?? "prod") as ShipTarget;
  if (!["dev", "staging", "prod"].includes(target)) throw new CliError(`Ship to dev, staging or prod, not "${targetArg}".`);
  if (opts.direct && target !== "prod") throw new CliError("--direct only applies when shipping to prod.");

  const [repoSlug, branch, changed] = await Promise.all([resolveRepo(repoArg), currentBranch(), changes()]);
  const api = await getClient();
  const { repo } = await api.repo(repoSlug);
  if (!repo.managed || !repo.branches) throw new CliError(`${repo.fullName} isn't set up in Oche yet. Run \`oche onboard\`.`);
  const b = repo.branches;
  if (branch === b.staging || branch === b.prod) {
    throw new CliError(`You're on ${branch}. Ship from ${b.dev} or a work branch; Oche moves things into ${branch} for you.`);
  }
  if (target === "dev" && branch === b.dev) throw new CliError(`You're already on ${b.dev}. Ship to staging or prod.`);

  // Everything that will happen, before anything happens.
  let message: string | null = null;
  let input: MessageInput | null = null;
  if (changed.length) {
    input = { ...(await previewAddAll()), recent: await recentSubjects(), branch };
    message = opts.message ?? (await writeMessage(api, input));
  }
  const behind = await unpushed();
  const steps = planLines(repo, branch, target, Boolean(opts.direct));

  for (;;) {
    print(`${c.bold(`Ship ${branch} to ${TARGET_LABEL[target]}`)}  ${c.dim(`${repo.fullName} · ${repo.mode}`)}`);
    print("");
    let n = 1;
    if (message) {
      print(`  ${n++}. Commit ${plural(changed.length, "file")}:`);
      for (const line of message.split("\n")) print(`       ${line ? c.bold(line) : ""}`);
      for (const ch of changed.slice(0, 12)) print(`       ${describeChange(ch)}`);
      if (changed.length > 12) print(c.dim(`       …and ${changed.length - 12} more`));
    }
    print(`  ${n++}. Push ${branch}${behind === null ? c.dim("  (new on GitHub)") : behind > 0 ? c.dim(`  (${plural(behind, "commit")} not pushed yet)`) : ""}`);
    for (const s of steps) print(`  ${n++}. ${s}`);
    if (target === "prod" && !repo.coolifyLinked) print(c.dim(`\n  Coolify deploys ${b.prod} when the last step lands.`));
    print("");

    if (opts.yes) break;
    if (!isInteractive()) throw new CliError("Shipping needs confirmation. Run it in a terminal, or pass --yes.");
    const choice = await choose("Ship it?", Boolean(message && !opts.message));
    if (choice === "no") return print("Nothing shipped.");
    if (choice === "rewrite" && input) {
      message = await writeMessage(api, input);
      continue;
    }
    if (choice === "edit" && message) {
      const edited = await ask("Message (one line; use `oche commit` for a longer one)", message.split("\n")[0]);
      message = edited.trim() || message;
      continue;
    }
    break;
  }

  // Go.
  if (message) {
    await addAll();
    await commit(message);
    ok("Committed");
  }
  process.stderr.write(c.dim(`Pushing ${branch}…\n`));
  await push(branch);
  ok(`Pushed ${branch}`);

  let run: ApiShipRun;
  try {
    ({ run } = await api.ship(repoSlug, { from: branch, to: target, direct: opts.direct }));
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 409) {
      const message = e.message.replace(/ \(HTTP 409\)$/, "");
      const id = /\(#(\d+)\)/.exec(message)?.[1];
      throw new CliError(id ? `${message}\n  Follow it in the dashboard, or cancel it with \`oche ship --cancel ${id}\`.` : message);
    }
    throw e;
  }
  print("");
  print(c.dim(`Ship #${run.id} is running on the server.`));
  closeReader();
  run = await followRun(api, run);

  switch (run.status) {
    case "succeeded":
      ok(`Shipped to ${TARGET_LABEL[target]}`);
      if (branch !== b.dev) print(c.dim(`\nYou're still on ${branch}. \`git switch ${b.dev} && git pull\` to carry on from ${b.dev}.`));
      break;
    case "stopped":
      warn("Stopped: a PR is waiting for review. Run `oche ship` again once it's approved; finished steps are skipped.");
      process.exitCode = 1;
      break;
    case "failed":
      warn("Stopped before the end. Sort out the step above, then run `oche ship` again; finished steps are skipped.");
      process.exitCode = 1;
      break;
    case "cancelled":
      warn(`Ship #${run.id} was cancelled. Steps that already merged stay merged.`);
      process.exitCode = 1;
      break;
  }
}

const POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls a run until it finishes, printing each step as it changes. Ctrl-C leaves it running on the server. */
async function followRun(api: Client, first: ApiShipRun): Promise<ApiShipRun> {
  const onSigint = () => {
    process.stderr.write(
      `\nThe ship keeps running on the server. Follow it in the dashboard, or cancel it with \`oche ship --cancel ${first.id}\`.\n`,
    );
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    let run = first;
    let shown: RunStep[] = [];
    let misses = 0;
    for (;;) {
      for (const line of stepUpdates(shown, run.steps)) print(line);
      shown = run.steps;
      if (run.status !== "running") return run;
      await sleep(POLL_MS);
      try {
        run = (await api.shipRun(run.id)).run;
        misses = 0;
      } catch (e) {
        // A blip in the connection shouldn't lose track of a run that's still going.
        if (e instanceof ApiRequestError || ++misses >= 5) throw e;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function cancelCommand(getClient: GetClient, idArg: string) {
  const id = Number(idArg.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) throw new CliError(`"${idArg}" isn't a ship run id. Use the number from \`oche ship\`, like 12.`);
  const api = await getClient();
  const { run } = await api.cancelShipRun(id);
  print(`${c.bold(`Ship #${run.id}`)}  ${c.dim(`${run.repo} · to ${TARGET_LABEL[run.request.to]} · by ${run.actor}`)}`);
  for (const line of stepUpdates([], run.steps)) print(line);
  if (run.status === "cancelled") ok(`Cancelled ship #${run.id}. Steps that already merged stay merged.`);
  else print(c.dim(`Ship #${run.id} had already finished: ${run.status}.`));
}
