import { Command, InvalidArgumentError, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { Client } from "./api.ts";
import type { ApiEvent, ApiRepo, Branches, EventType, Mode, RepoResponse } from "./api-types.ts";
import {
  deployCommand,
  deploymentsCommand,
  envsCommand,
  explainCommand,
  logsCommand,
  preflightCommand,
  rollbackCommand,
} from "./coolify.ts";
import {
  configPath,
  DEFAULT_SERVER_URL,
  DEFAULT_TOKEN_PAGE,
  deleteConfig,
  loadConfig,
  normalizeUrl,
  resolveConfig,
  saveConfig,
} from "./config.ts";
import { ApiRequestError, CliError } from "./errors.ts";
import { resolveRepo, slug, type RepoSlug } from "./git.ts";
import { needsConfirmation, promotionRefs, toPromotion } from "./promotion.ts";
import { DEFAULT_MODEL, loadLocalConfig, localConfigPath, saveLocalConfig } from "./local-config.ts";
import { npmSetupCommand, npmStatusCommand } from "./npm.ts";
import { prCommand } from "./pr.ts";
import { commitCommand, shipCommand } from "./ship.ts";
import {
  askHidden,
  c,
  columns,
  confirm,
  isInteractive,
  ok,
  plural,
  print,
  printJson,
  relativeTime,
  truncate,
  warn,
  type Cell,
} from "./ui.ts";

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

async function client(): Promise<Client> {
  const cfg = resolveConfig(await loadConfig(), process.env);
  if (!cfg.url || !cfg.token) {
    throw new CliError(
      cfg.url && cfg.urlSource === "env"
        ? `No token for ${cfg.url}. Set OCHE_TOKEN or run \`oche login\`.`
        : "Not logged in. Run `oche login` (or set OCHE_URL and OCHE_TOKEN).",
    );
  }
  return new Client(cfg.url, cfg.token, cfg.tokenSource);
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("Must be a whole number of 1 or more.");
  return n;
}

function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("Must be a whole number of 0 or more.");
  return n;
}

const modeLabel = (repo: Pick<ApiRepo, "mode" | "requiredApprovals">) =>
  repo.mode === "strict" ? `strict · ${plural(repo.requiredApprovals, "approval")}` : "fast";

const BAD_EVENTS = new Set<EventType>(["promotion-conflict", "sync-conflict", "pr-blocked", "direct-push", "deploy-failed", "app-stopped", "publish-failed"]);
const GOOD_EVENTS = new Set<EventType>(["promoted", "synced", "onboarded", "deploy-succeeded", "published"]);

const newestFirst = (events: ApiEvent[]) =>
  [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);

function eventLines(events: ApiEvent[], showRepo: boolean): string[] {
  return columns(
    newestFirst(events).map((e) => {
      const when = relativeTime(e.createdAt);
      const type = BAD_EVENTS.has(e.type) ? c.red(e.type) : GOOD_EVENTS.has(e.type) ? c.green(e.type) : e.type;
      const tail = [e.prNumber ? `#${e.prNumber}` : "", e.actor ? `@${e.actor}` : ""].filter(Boolean).join(" ");
      const row: Cell[] = [[when, c.dim(when)]];
      if (showRepo) row.push(e.repo);
      row.push([e.type, type], `${e.summary}${tail ? `  ${c.dim(tail)}` : ""}`);
      return row;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* login / logout                                                      */
/* ------------------------------------------------------------------ */

async function login(urlArg: string | undefined) {
  const saved = await loadConfig().catch(() => null);
  // Hosted Oche unless told otherwise; self-hosters pass their URL once.
  const url = normalizeUrl(urlArg ?? process.env.OCHE_URL ?? saved?.url ?? DEFAULT_SERVER_URL);
  const where = url === DEFAULT_SERVER_URL ? DEFAULT_TOKEN_PAGE : "your Oche dashboard under Settings";
  process.stderr.write(`Logging in to ${c.bold(url)}\n`);
  process.stderr.write(c.dim(`Create a CLI token at ${where}, then paste it here.\n`));
  const token = await askHidden("CLI token");
  if (!token) throw new CliError("No token entered.");

  const me = await new Client(url, token, "config").me().catch((e: unknown) => {
    if (e instanceof ApiRequestError && e.status === 401) {
      throw new CliError(`${url} rejected that token (401). Check it and try again.`);
    }
    throw e;
  });
  const path = configPath();
  await saveConfig({ url, token, login: me.login }, path);
  ok(`Logged in to ${url} as ${c.bold(me.login)} (${me.role}).`);
  print(c.dim(`Saved to ${path}`));
  if (process.env.OCHE_TOKEN || process.env.OCHE_URL) {
    warn("OCHE_URL / OCHE_TOKEN are set and take precedence over the saved login.");
  }
}

async function logout() {
  const saved = await loadConfig().catch(() => null);
  if (await deleteConfig()) {
    ok(`Logged out${saved?.url ? ` of ${saved.url}` : ""}.`);
    print(c.dim("The token keeps working until you revoke it in the dashboard (Settings → CLI tokens)."));
  } else {
    print("Not logged in.");
  }
  if (process.env.OCHE_TOKEN) warn("OCHE_TOKEN is still set in your environment.");
}

/* ------------------------------------------------------------------ */
/* status / repos / log                                                */
/* ------------------------------------------------------------------ */

/** "work PRs: squash · production waits for staging: yes (Coolify linked)" */
export function settingsLine(repo: Partial<Pick<ApiRepo, "workMergeMethod" | "gateOnStaging" | "coolifyLinked">>): string | null {
  const parts: string[] = [];
  if (repo.workMergeMethod) parts.push(`work PRs: ${repo.workMergeMethod}`);
  if (repo.coolifyLinked) parts.push(`production waits for staging: ${repo.gateOnStaging ? "yes" : "no"} (Coolify linked)`);
  return parts.length ? parts.join(" · ") : null;
}

function printStatus({ repo, status, events }: RepoResponse) {
  print(`${c.bold(repo.fullName)}  ${repo.managed ? modeLabel(repo) : c.yellow("not managed")}`);
  print(c.dim(repo.htmlUrl));
  const settings = settingsLine(repo);
  if (repo.managed && settings) print(c.dim(settings));

  if (!repo.managed) {
    print();
    print(`Run ${c.cyan(`oche onboard ${repo.fullName}`)} to set up the dev → staging → main flow.`);
    return;
  }

  const b = repo.branches;
  if (!status || !b) {
    print();
    print(c.yellow("Branch status is unavailable right now (GitHub didn't answer)."));
  } else {
    print();
    print(c.bold("Branches"));
    const heads = (["prod", "staging", "dev"] as const).map((stage): Cell[] => {
      const h = status.heads[stage];
      if (!h) return [b[stage], ["missing", c.red("missing")]];
      const sha = h.sha.slice(0, 7);
      const meta = [h.author ? `@${h.author}` : "", relativeTime(h.date)].filter(Boolean).join(" · ");
      return [b[stage], [sha, c.dim(sha)], `${truncate(h.message, 56)}  ${c.dim(meta)}`];
    });
    columns(heads).forEach((l) => print(l));

    print();
    print(c.bold("Pending"));
    const count = (n: number): Cell => (n ? [plural(n, "commit"), c.yellow(plural(n, "commit"))] : ["none", c.dim("none")]);
    columns([
      [`${b.dev} → ${b.staging}`, count(status.pending.staging)],
      [`${b.staging} → ${b.prod}`, count(status.pending.prod)],
      [`${b.dev} → ${b.prod}`, count(status.pending.prodDirect)],
    ]).forEach((l) => print(l));

    print();
    print(c.bold("Pull requests"));
    if (status.openPromotions.length) {
      columns(status.openPromotions.map((p): Cell[] => [`#${p.number}`, `${p.head} → ${p.base}`, c.dim(p.url)])).forEach(
        (l) => print(l),
      );
    } else {
      print(c.dim("  no open promotion PRs"));
    }
    const blocked = status.blockedPullRequests;
    print(`  ${blocked ? c.red(`${plural(blocked, "PR")} blocked by the flow`) : c.dim("none blocked")}`);
  }

  print();
  print(c.bold("Recent events"));
  if (events.length) eventLines(newestFirst(events).slice(0, 5), false).forEach((l) => print(l));
  else print(c.dim("  none yet"));
}

async function status(repoArg: string | undefined, opts: { json?: boolean }) {
  const repo = await resolveRepo(repoArg);
  const data = await (await client()).repo(repo);
  if (opts.json) return printJson(data);
  printStatus(data);
}

async function repos(opts: { json?: boolean }) {
  const { repos } = await (await client()).repos();
  const sorted = [...repos].sort((a, b) => Number(b.managed) - Number(a.managed) || a.fullName.localeCompare(b.fullName));
  if (opts.json) return printJson({ repos: sorted });
  if (!sorted.length) {
    print("No repos yet. Install the Oche GitHub App on a repo, then run `oche onboard owner/repo`.");
    return;
  }
  columns(
    sorted.map((r): Cell[] =>
      r.managed
        ? [["✓", c.green("✓")], r.fullName, modeLabel(r)]
        : [" ", [r.fullName, c.dim(r.fullName)], c.dim("not managed")],
    ),
    "",
  ).forEach((l) => print(l));
  const managed = sorted.filter((r) => r.managed).length;
  print(c.dim(`\n${managed} managed, ${sorted.length - managed} not managed`));
}

async function log(repoArg: string | undefined, opts: { json?: boolean; limit: number }) {
  // Outside a git checkout with no repo given, show events across all repos.
  const repo: RepoSlug | null = repoArg ? await resolveRepo(repoArg) : await resolveRepo(undefined).catch(() => null);
  const { events } = await (await client()).events(repo, opts.limit);
  if (opts.json) return printJson({ events });
  if (!events.length) {
    print(c.dim(repo ? `No events for ${slug(repo)} yet.` : "No events yet."));
    return;
  }
  eventLines(events, !repo).forEach((l) => print(l));
}

/* ------------------------------------------------------------------ */
/* promote / onboard / mode                                            */
/* ------------------------------------------------------------------ */

async function promote(target: string, repoArg: string | undefined, opts: { direct?: boolean; yes?: boolean }) {
  const promotion = toPromotion(target, opts.direct);
  const repo = await resolveRepo(repoArg);
  const api = await client();

  let branches: Branches | null = null;
  if (needsConfirmation(promotion) && !opts.yes) {
    const { repo: info, status: st } = await api.repo(repo);
    if (!info.managed) throw new CliError(`${info.fullName} isn't managed by Oche yet. Run \`oche onboard ${info.fullName}\`.`);
    branches = info.branches;
    const { head, base } = promotionRefs(promotion, branches);
    const pending = st ? (promotion === "prod" ? st.pending.prod : st.pending.prodDirect) : null;
    if (pending === 0) {
      print(`Nothing to promote: ${base} already has everything in ${head}.`);
      return;
    }
    const what = pending === null ? `${head} → ${base}` : `${plural(pending, "commit")} ${head} → ${base}`;
    if (!(await confirm(`Promote ${what} on ${slug(repo)} (production)?`))) {
      print("Cancelled.");
      return;
    }
  }

  const { head, base } = promotionRefs(promotion, branches);
  process.stderr.write(c.dim(`Promoting ${head} → ${base} on ${slug(repo)}…\n`));
  const result = await api.promote(repo, promotion);

  switch (result.status) {
    case "merged":
      ok(`Merged #${result.pr.number} ${result.pr.head} → ${result.pr.base}`);
      print(`  → ${result.pr.url}`);
      return;
    case "waiting-review": {
      const a = result.approval;
      const note = a.changesRequested ? ", changes requested" : "";
      print(`#${result.pr.number} ${result.pr.head} → ${result.pr.base} is waiting for review: ${c.yellow(`${a.approvals}/${a.required} approvals`)}${note}`);
      print(`  → ${result.pr.url}`);
      return;
    }
    case "nothing-to-promote":
      print(`Nothing to promote: ${base} already has everything in ${head}.`);
      return;
    case "conflict":
      print(`${c.red("✗")} #${result.pr.number} ${result.pr.head} → ${result.pr.base} has merge conflicts. Resolve them on GitHub, then run this again.`);
      print(`  → ${result.pr.url}`);
      process.exitCode = 1;
      return;
    case "blocked":
      print(`${c.red("✗")} Blocked: ${result.reason}`);
      process.exitCode = 1;
      return;
  }
}

async function onboard(repoArg: string | undefined, opts: { yes?: boolean; dryRun?: boolean }) {
  const repo = await resolveRepo(repoArg);
  const api = await client();
  const { plan, repo: info } = await api.onboard(repo, true);

  const b = plan.branches;
  print(`${c.bold(info.fullName)}  ${c.dim(`${b.dev} → ${b.staging} → ${b.prod}`)}`);
  for (const s of plan.steps) print(`  ${s.done ? c.green("✓") : c.dim("·")} ${s.done ? c.dim(s.label) : s.label}`);

  const todo = plan.steps.filter((s) => !s.done).length;
  if (info.managed && todo === 0) {
    ok(`${info.fullName} is already onboarded.`);
    return;
  }
  if (opts.dryRun) {
    print(c.dim(`\nDry run: ${plural(todo, "step")} to apply.`));
    return;
  }
  if (!opts.yes && !(await confirm(`Apply ${plural(todo, "step")} to ${info.fullName}?`, true))) {
    print("Cancelled.");
    return;
  }

  const applied = await api.onboard(repo, false);
  ok(`${applied.repo.fullName} is managed by Oche (${modeLabel(applied.repo)}).`);
}

async function setMode(mode: string, repoArg: string | undefined, opts: { approvals?: number }) {
  if (mode !== "fast" && mode !== "strict") throw new CliError(`Unknown mode "${mode}". Use fast or strict.`);
  const repo = await resolveRepo(repoArg);
  const { repo: updated } = await (await client()).updateRepo(repo, {
    mode: mode satisfies Mode,
    ...(opts.approvals === undefined ? {} : { requiredApprovals: opts.approvals }),
  });
  if (updated.mode === "strict") {
    ok(`${updated.fullName} is now strict: ${plural(updated.requiredApprovals, "approval")} required to promote.`);
  } else {
    ok(`${updated.fullName} is now fast: promotions merge without review.`);
    if (opts.approvals !== undefined) {
      print(c.dim(`  ${plural(updated.requiredApprovals, "approval")} will apply if you switch to strict.`));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Program                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* ai-key                                                              */
/* ------------------------------------------------------------------ */

async function aiKey(opts: { model?: string; clear?: boolean }) {
  const saved = await loadLocalConfig();
  const path = localConfigPath();
  if (opts.clear) {
    await saveLocalConfig({ ...saved, openrouterKey: undefined }, path);
    return ok("Forgot the OpenRouter key.");
  }
  let key = saved.openrouterKey;
  if (!opts.model || !key) {
    if (isInteractive()) process.stderr.write(c.dim("Create one at https://openrouter.ai/settings/keys\n"));
    key = (await askHidden("OpenRouter API key")) || key;
  }
  if (!key) throw new CliError("No key entered.");
  const model = opts.model?.trim() || saved.model;
  await saveLocalConfig({ openrouterKey: key, model }, path);
  ok(`Saved. \`oche pr\` will write commit messages with ${c.bold(model ?? DEFAULT_MODEL)}.`);
  print(c.dim(`Saved to ${path}`));
  if (process.env.OPENROUTER_API_KEY) warn("OPENROUTER_API_KEY is set and takes precedence over the saved key.");
}

export function buildProgram(): Command {
  const program = new Command()
    .name("oche")
    .description("Promote dev → staging → main from your terminal.")
    .version(pkg.version, "-v, --version")
    .showSuggestionAfterError();

  const repoArg = "[owner/repo]";
  const repoHelp = "defaults to the GitHub repo of git remote origin";

  program.command("login").description("Sign in with a CLI token from the dashboard").argument("[url]", "Oche server URL (only if you self-host)").action(login);

  program.command("logout").description("Forget the saved login").action(logout);

  program
    .command("status")
    .description("Branches, pending commits, promotion PRs and recent events")
    .argument(repoArg, repoHelp)
    .option("--json", "print raw JSON")
    .action(status);

  program.command("repos").description("List repos, managed first").option("--json", "print raw JSON").action(repos);

  program
    .command("promote")
    .description("Promote dev → staging, or staging → main")
    .argument("<target>", "staging or prod")
    .argument(repoArg, repoHelp)
    .option("--direct", "with prod: ship dev straight to main, skipping staging")
    .option("-y, --yes", "don't ask for confirmation")
    .action(promote);

  program
    .command("ship")
    .description("Commit what's changed, push, and take it all the way up with one confirmation")
    .argument("[target]", "dev, staging or prod", "prod")
    .argument(repoArg, repoHelp)
    .option("--direct", "with prod: dev → main, skipping staging (Oche syncs staging after)")
    .option("-m, --message <message>", "commit message to use instead of writing one with AI")
    .option("-y, --yes", "don't ask for confirmation")
    .option("--cancel <runId>", "cancel a running ship by its number instead of starting one")
    .action((target, repo, opts) => shipCommand(client, target, repo, opts));

  program
    .command("pr")
    .description("Commit what's changed with AI, push this work branch and open a PR into dev — no Oche server needed")
    .option("--base <branch>", "branch the PR goes into (default: dev, or develop if there's no dev)")
    .option("--merge", "merge the PR once it's open")
    .option("--squash", "with --merge: squash merge")
    .option("--rebase", "with --merge: rebase merge")
    .option("-d, --delete-branch", "with --merge: delete the work branch on GitHub afterwards")
    .option("--draft", "open the PR as a draft")
    .option("-t, --title <title>", "PR title (default: the commit subject, or the branch name for several commits)")
    .option("-m, --message <message>", "commit message to use instead of writing one with AI")
    .option("-y, --yes", "don't ask for confirmation")
    .option("--dry-run", "only show the plan, with the AI commit message")
    .option("--json", "machine-readable output (needs --yes or --dry-run)")
    .action((opts) => prCommand(opts));

  program
    .command("ai-key")
    .description("Save the OpenRouter key (and model) `oche pr` writes commit messages with")
    .option("--model <id>", `OpenRouter model id (default ${DEFAULT_MODEL})`)
    .option("--clear", "forget the saved key")
    .action(aiKey);

  program
    .command("commit")
    .description("Write a commit message for what's staged with AI (via your Oche server) and commit")
    .option("-a, --all", "stage changes to tracked files first, like git commit -a")
    .option("-m, --message <message>", "skip AI and use this message")
    .option("--dry-run", "only print the message")
    .option("-y, --yes", "commit without asking")
    .action((opts) => commitCommand(client, opts));

  program
    .command("onboard")
    .description("Set up the dev → staging → main flow on a repo")
    .argument(repoArg, repoHelp)
    .option("--dry-run", "only show the plan")
    .option("-y, --yes", "don't ask for confirmation")
    .action(onboard);

  program
    .command("mode")
    .description("Switch between fast (no review) and strict (approvals required)")
    .argument("<mode>", "fast or strict")
    .argument(repoArg, repoHelp)
    .option("--approvals <n>", "approvals required in strict mode", nonNegativeInt)
    .action(setMode);

  /* ---- Coolify ---- */

  const stageOption = (description: string) => new Option("--stage <stage>", description).choices(["prod", "staging", "dev"]);
  const appOption = new Option("--app <name>", "which Coolify app (its name, or the start of its uuid)");

  program
    .command("logs")
    .description("Container logs for an app, or a deployment's build log with --build")
    .argument(repoArg, repoHelp)
    .addOption(appOption)
    .addOption(stageOption("the app deploying this stage"))
    .option("--deployment <uuid>", "build log of this deployment (implies --build; default: the latest)")
    .option("--build", "the build log of the latest deployment, not the running container")
    .addOption(new Option("-n, --lines <n>", "how many lines from the end; 0 for all").default(200).argParser(nonNegativeInt))
    .option("--failures", "only the errors and the tail")
    .option("--json", "print raw JSON")
    .action((repo, opts) => logsCommand(client, repo, opts));

  program
    .command("deployments")
    .description("Recent deployments per app, with status, commit and how long each took")
    .argument(repoArg, repoHelp)
    .addOption(appOption)
    .addOption(stageOption("only apps deploying this stage"))
    .addOption(new Option("-n, --limit <n>", "deployments per app").default(5).argParser(positiveInt))
    .option("--json", "print raw JSON")
    .action((repo, opts) => deploymentsCommand(client, repo, opts));

  const npm = program.command("npm").description("Publish this package to npm on every release");
  npm
    .command("setup")
    .description("Add the publish workflow and let npm trust it (uses your npm login)")
    .argument(repoArg, repoHelp)
    .option("-y, --yes", "don't ask for confirmation")
    .option("--force", "set up even if another workflow already publishes to npm")
    .option("--skip-pr", "only do the npm side; don't open the workflow PR")
    .action((repo, opts) => npmSetupCommand(client, repo, opts));
  npm
    .command("status", { isDefault: true })
    .description("Publishing setup, the npm version and the last run")
    .argument(repoArg, repoHelp)
    .option("--json", "print raw JSON")
    .action((repo, opts) => npmStatusCommand(client, repo, opts));

  program
    .command("envs")
    .description("Which stages define each environment variable (names only, never values)")
    .argument(repoArg, repoHelp)
    .addOption(stageOption("only this stage's column"))
    .option("--key <name>", "only variables whose name contains this")
    .option("--json", "print raw JSON")
    .action((repo, opts) => envsCommand(client, repo, opts));

  program
    .command("deploy")
    .description("Redeploy an app on Coolify")
    .argument(repoArg, repoHelp)
    .addOption(appOption)
    .addOption(stageOption("the app deploying this stage"))
    .option("--force", "rebuild without the build cache")
    .option("-y, --yes", "don't ask for confirmation")
    .option("--json", "print raw JSON")
    .action((repo, opts) => deployCommand(client, repo, opts));

  program
    .command("rollback")
    .description("List the images Coolify can roll an app back to, and roll back to one")
    .argument(repoArg, repoHelp)
    .addOption(appOption)
    .addOption(stageOption("the app deploying this stage"))
    .option("--to <commit>", "roll back to this image (a commit SHA from the list)")
    .option("-y, --yes", "don't ask for confirmation")
    .option("--json", "print raw JSON")
    .action((repo, opts) => rollbackCommand(client, repo, opts));

  program
    .command("explain")
    .description("Ask your Oche server's AI what broke a deployment")
    .argument(repoArg, repoHelp)
    .addOption(appOption)
    .addOption(stageOption("the app deploying this stage"))
    .option("--deployment <uuid>", "explain this deployment (default: the latest failed one)")
    .option("--json", "print raw JSON")
    .action((repo, opts) => explainCommand(client, repo, opts));

  program
    .command("preflight")
    .description("What to know before promoting: missing variables and the health of the stage below")
    .argument(repoArg, repoHelp)
    .addOption(new Option("--to <stage>", "the stage being promoted into").choices(["prod", "staging"]).default("prod"))
    .option("--json", "print raw JSON")
    .action((repo, opts) => preflightCommand(client, repo, opts));

  program
    .command("log")
    .description("Recent events (all repos when run outside a checkout)")
    .argument(repoArg, repoHelp)
    .addOption(new Option("-n, --limit <n>", "how many events").default(20).argParser(positiveInt))
    .option("--json", "print raw JSON")
    .action(log);

  return program;
}
