/**
 * npm publishing. The Oche server adds a workflow that publishes on every push
 * to production; `oche npm setup` does the part that needs your own npm login:
 * the first publish of a new package, and telling npm to trust the workflow.
 */
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Client } from "./api.ts";
import type { NpmStatusResponse } from "./api-types.ts";
import { ApiRequestError, CliError } from "./errors.ts";
import { resolveRepo, slug } from "./git.ts";
import { c, closeReader, confirm, isInteractive, ok, print, printJson, relativeTime, warn } from "./ui.ts";

type GetClient = () => Promise<Client>;

const WORKFLOW_FILE = "oche-publish.yml";
const exec = promisify(execFile);

/** npm 12 has `npm trust`. Older npms borrow it through npx. */
async function npmBin(): Promise<string[]> {
  try {
    const { stdout } = await exec("npm", ["--version"]);
    const major = Number(stdout.trim().split(".")[0]);
    return major >= 12 ? ["npm"] : ["npx", "-y", "npm@12"];
  } catch {
    throw new CliError("npm isn't installed.");
  }
}

async function npmOut(bin: string[], args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(bin[0]!, [...bin.slice(1), ...args]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Runs npm attached to the terminal, so its own 2FA and login prompts work. */
function npmLive(bin: string[], args: string[]): Promise<void> {
  closeReader();
  return new Promise((resolve, reject) => {
    const child = spawn(bin[0]!, [...bin.slice(1), ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new CliError(`npm ${args[0]} failed (exit ${code}).`))));
  });
}

async function localPackage(): Promise<{ name?: string; version?: string } | null> {
  try {
    return JSON.parse(await readFile("package.json", "utf8"));
  } catch {
    return null;
  }
}

function printSteps(st: NpmStatusResponse) {
  for (const s of st.steps) {
    print(`  ${s.done ? c.green("✓") : c.dim("○")} ${s.label}${!s.done && s.hint ? c.dim(`  ${s.hint}`) : ""}`);
  }
}

export async function npmStatusCommand(client: GetClient, repoArg: string | undefined, opts: { json?: boolean }) {
  const repo = await resolveRepo(repoArg);
  const st = await (await client()).npmStatus(repo);
  if (opts.json) return printJson(st);

  const name = st.publishing?.packageName ?? st.detected.name;
  print(`${c.bold(slug(repo))}${name ? `  ${name}` : ""}`);
  if (st.blocked && !st.publishing) {
    print(c.dim(st.blocked));
    return;
  }
  if (st.registry) {
    print(st.registry.exists ? `  npm: ${c.bold(st.registry.latest ?? "?")}${st.registry.publishedAt ? c.dim(` · ${relativeTime(st.registry.publishedAt)}`) : ""}` : c.dim("  not on npm yet"));
  }
  const run = st.publishing?.lastRun;
  if (run) {
    const label = run.conclusion === "success" ? c.green(run.conclusion) : run.conclusion === "failure" ? c.red(run.conclusion) : run.conclusion;
    print(`  last run: ${label}${run.failedStep ? ` at "${run.failedStep}"` : ""} ${c.dim(`${relativeTime(run.at)} · ${run.url}`)}`);
  }
  if (st.publishing?.outdated) warn("The workflow is out of date. `oche npm setup` opens a PR to update it.");
  print();
  printSteps(st);
  if (!st.publishing) print(c.dim(`\nRun \`oche npm setup ${slug(repo)}\` to start publishing on every release.`));
}

export async function npmSetupCommand(
  client: GetClient,
  repoArg: string | undefined,
  opts: { yes?: boolean; force?: boolean; skipPr?: boolean },
) {
  const repo = await resolveRepo(repoArg);
  const api = await client();
  let st = await api.npmStatus(repo);
  if (st.blocked) throw new CliError(st.blocked);
  const name = st.publishing?.packageName ?? st.detected.name!;
  const local = await localPackage();
  const inRepo = local?.name === name;
  const ask = async (q: string) => opts.yes || (isInteractive() && (await confirm(q, true)));

  print(`Setting up npm publishing for ${c.bold(name)} from ${c.bold(slug(repo))}.\n`);
  if (st.detected.otherPublishers.length && !st.publishing) {
    warn(`${st.detected.otherPublishers.join(", ")} already publishes to npm. Two publishers will race each other.`);
    if (!opts.force && !(await ask("Add Oche's workflow anyway?"))) throw new CliError("Stopped. Remove the other workflow, or pass --force.");
    opts.force = true;
  }

  // 1. Your npm login. The server never holds npm credentials.
  const bin = await npmBin();
  let npmUser = await npmOut(bin, ["whoami"]);
  if (!npmUser) {
    if (!(await ask("You're not logged in to npm. Log in now?"))) throw new CliError("Log in with `npm login`, then run this again.");
    await npmLive(bin, ["login"]);
    npmUser = await npmOut(bin, ["whoami"]);
    if (!npmUser) throw new CliError("Still not logged in to npm.");
  }
  ok(`npm: logged in as ${c.bold(npmUser)}`);

  // 2. npm can only trust a workflow for a package that exists, so a new one goes up by hand once.
  if (!st.registry?.exists) {
    if (!inRepo) throw new CliError(`${name} isn't on npm yet. Run this from the repo's folder so Oche can publish the first version from it.`);
    print(`${name} isn't on npm yet. The first version has to be published from your machine; Oche takes over after that.`);
    if (!(await ask(`Build and publish ${name}@${local!.version} now?`))) throw new CliError("Publish it once with `npm publish`, then run this again.");
    await npmLive(bin, ["run", "build", "--if-present"]);
    await npmLive(bin, ["publish", "--access", "public"]);
    ok(`Published ${name}@${local!.version}`);
  } else {
    const owners = await npmOut(bin, ["owner", "ls", name]);
    if (owners && !owners.split("\n").some((l) => l.split(" ")[0] === npmUser)) {
      warn(`${npmUser} isn't listed as an owner of ${name}. npm may refuse to change its trust settings.`);
    }
  }

  // 3. The workflow, through a PR into dev.
  if (!opts.skipPr && (!st.publishing || st.publishing.outdated)) {
    try {
      const res = await api.npmSetup(repo, { force: opts.force });
      if (res.pr) ok(`${res.pr.merged ? "Merged" : "Opened"} #${res.pr.number}: ${res.path}  ${c.dim(res.pr.url)}`);
      else ok(`${res.path} is already on dev.`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 403) throw new CliError("Only the Oche owner can add the workflow. Ask them to run `oche npm setup`, then run it yourself for the npm side.");
      throw e;
    }
  }

  // 4. Tell npm to trust the workflow (OIDC). This is the step that needs your npm account.
  const trusted = await npmOut(bin, ["trust", "list", name, "--json"]);
  const already = Boolean(trusted && trusted.includes(`${repo.owner}/${repo.repo}`) && trusted.includes(WORKFLOW_FILE));
  if (already) {
    ok(`npm already trusts ${WORKFLOW_FILE} in ${slug(repo)}`);
  } else {
    print(`\nnpm will trust ${c.bold(`${slug(repo)} → .github/workflows/${WORKFLOW_FILE}`)} to publish ${name}. npm may ask for 2FA.`);
    if (!(await ask("Continue?"))) throw new CliError("Stopped before changing npm's trust settings.");
    await npmLive(bin, ["trust", "github", name, "--file", WORKFLOW_FILE, "--repository", slug(repo), "--allow-publish", ...(opts.yes ? ["--yes"] : [])]);
    ok("npm trusts the workflow");
  }
  st = await api.npmTrust(repo, { packageName: name, npmUser });

  print();
  printSteps(st);
  const next = st.steps.find((s) => !s.done && s.id !== "published");
  print(next ? c.dim(`\nNext: ${next.hint ?? next.label}`) : c.dim("\nEvery push to production now publishes a new version."));
}
