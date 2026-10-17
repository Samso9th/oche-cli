/**
 * The Coolify side of a repo: what is deployed, why a container is unhappy,
 * and the levers to put it right. Everything goes through the Oche server,
 * which holds the Coolify token; the CLI never talks to Coolify itself.
 */
import type { Client } from "./api.ts";
import type { ApiCoolifyApp, ApiDeployment, EnvComparison, EnvIssue, LogLine, RepoDeploymentsResponse, Stage } from "./api-types.ts";
import { CliError } from "./errors.ts";
import { resolveRepo, slug, type RepoSlug } from "./git.ts";
import { c, columns, confirm, duration, ok, paint, plural, print, printJson, relativeTime, truncate, type Cell } from "./ui.ts";

type GetClient = () => Promise<Client>;

/** Which app a command works on. Every Coolify command takes these. */
interface AppOpts {
  app?: string;
  stage?: Stage;
  json?: boolean;
}

const STAGES: Stage[] = ["dev", "staging", "prod"];
const STAGE_LABEL: Record<Stage, string> = { dev: "dev", staging: "staging", prod: "production" };

const appLabel = (a: { name: string; stage: Stage }) => `${a.name} (${a.stage})`;

/** Coolify marks log lines that can hold secrets. They never reach the terminal. */
const visible = (lines: LogLine[]) => lines.filter((l) => !l.hidden);

/** Progress and context go to stderr, so stdout stays pipeable into grep. */
const note = (text: string) => void process.stderr.write(`${paint("dim", text, process.stderr)}\n`);

function stateText(app: { state: string; health: string | null }): string {
  const text = app.health ? `${app.state}:${app.health}` : app.state;
  if (app.state === "running") return app.health === "unhealthy" ? c.yellow(text) : c.green(text);
  if (app.state === "unknown") return c.dim(text);
  return c.red(text);
}

function statusText(status: string): string {
  if (status === "finished") return c.green(status);
  if (status === "failed") return c.red(status);
  if (status === "queued" || status === "in_progress") return c.yellow(status);
  return c.dim(status);
}

/* ------------------------------------------------------------------ */
/* Picking an app                                                      */
/* ------------------------------------------------------------------ */

/** The repo's Coolify apps, with the "nothing to show" cases spelled out. */
async function coolifyApps(api: Client, repo: RepoSlug): Promise<RepoDeploymentsResponse> {
  const data = await api.deployments(repo);
  if (!data.instance) {
    throw new CliError(`${slug(repo)} isn't linked to a Coolify instance. Link one in the dashboard, under the repo's Coolify panel.`);
  }
  if (!data.apps.length) {
    const others = [...data.otherBranches.map((a) => `${a.name} (${a.branch ?? "?"})`), ...data.sameName.map((a) => `${a.name} (${a.repo ?? "?"})`)];
    throw new CliError(
      others.length
        ? `No Coolify app builds ${slug(repo)} from its dev, staging or main branch. Coolify has: ${others.join(", ")}.`
        : `No Coolify app builds ${slug(repo)}. Set one up in the dashboard, under the repo's Coolify panel.`,
    );
  }
  return data;
}

function matching(apps: ApiCoolifyApp[], opts: AppOpts): ApiCoolifyApp[] {
  const wanted = opts.app?.trim().toLowerCase();
  return apps.filter(
    (a) =>
      (!opts.stage || a.stage === opts.stage) &&
      (!wanted || a.name.toLowerCase() === wanted || a.uuid === wanted || a.uuid.startsWith(wanted)),
  );
}

const appList = (apps: ApiCoolifyApp[]) => apps.map(appLabel).join(", ");

/** Exactly one app, or an error that says which ones there are. */
export function pickApp(data: RepoDeploymentsResponse, opts: AppOpts): ApiCoolifyApp {
  const found = matching(data.apps, opts);
  if (found.length === 1) return found[0]!;
  if (!found.length) {
    const asked = [opts.app ? `--app ${opts.app}` : "", opts.stage ? `--stage ${opts.stage}` : ""].filter(Boolean).join(" ");
    throw new CliError(`Nothing matches ${asked}. This repo has: ${appList(data.apps)}.`);
  }
  throw new CliError(`Several apps match: ${appList(found)}. Pick one with --app <name> or --stage <prod|staging|dev>.`);
}

/* ------------------------------------------------------------------ */
/* oche logs                                                           */
/* ------------------------------------------------------------------ */

interface LogOpts extends AppOpts {
  deployment?: string;
  lines: number;
  failures?: boolean;
  build?: boolean;
}

const MAX_TAIL = 2000;

/**
 * The container's own log by default: what a crash-looping app printed before
 * it died. --build (or --deployment) reads a build log instead.
 */
export async function logsCommand(getClient: GetClient, repoArg: string | undefined, opts: LogOpts) {
  const repo = await resolveRepo(repoArg);
  const api = await getClient();
  const app = pickApp(await coolifyApps(api, repo), opts);
  const tail = opts.lines === 0 ? MAX_TAIL : opts.lines;

  if (!opts.build && !opts.deployment) {
    const logs = await api.appLogs(repo, app.uuid, tail);
    const lines = visible(logs.lines);
    if (opts.json) return printJson({ ...logs, lines });
    note(`${appLabel(app)} · container log · ${stateText(logs.app)}${app.fqdn ? ` · ${app.fqdn}` : ""}`);
    if (!lines.length) note("Coolify returned no container log. The app may never have started; try --build.");
    return printLines(opts.failures ? logs.excerpt : lines.map((l) => l.output), opts.failures ? 0 : tail);
  }

  const deploymentUuid = opts.deployment ?? app.deployments[0]?.uuid;
  if (!deploymentUuid) throw new CliError(`${appLabel(app)} has no deployments on Coolify yet. Start one with \`oche deploy --app ${app.name}\`.`);
  const detail = await api.deployment(repo, app.uuid, deploymentUuid);
  const lines = visible(detail.lines);
  if (opts.json) return printJson({ ...detail, lines });
  const d = detail.deployment;
  note(`${appLabel(app)} · build log · ${d.status} · ${d.commit?.slice(0, 7) ?? "?"} · ${relativeTime(d.updatedAt)} · ${deploymentUuid}`);
  // Say so rather than printing a header and nothing. An empty build log is
  // usually Coolify holding it back from a token without read:sensitive, or a
  // deployment old enough to have been pruned, and silence reads as "no
  // problem found" when neither is true.
  if (!lines.length) {
    note("Coolify returned no build log for this deployment. Check the Coolify API token has read:sensitive, or try a more recent deployment.");
    return;
  }
  // A build log arrives whole, so the tail is taken here; 0 keeps all of it.
  printLines(opts.failures ? detail.excerpt : lines.map((l) => l.output), opts.failures ? 0 : opts.lines);
}

/** Prints the last `tail` lines (0 for all), saying so when something was left out. */
function printLines(lines: string[], tail: number) {
  const shown = tail > 0 && lines.length > tail ? lines.slice(-tail) : lines;
  if (shown.length < lines.length) note(`…showing the last ${plural(shown.length, "line")} of ${lines.length}; -n 0 for all.`);
  for (const line of shown) print(line);
}

/* ------------------------------------------------------------------ */
/* oche deployments                                                    */
/* ------------------------------------------------------------------ */

export async function deploymentsCommand(getClient: GetClient, repoArg: string | undefined, opts: AppOpts & { limit: number }) {
  const repo = await resolveRepo(repoArg);
  const data = await coolifyApps(await getClient(), repo);
  const apps = matching(data.apps, opts);
  if (!apps.length) throw new CliError(`Nothing matches. This repo has: ${appList(data.apps)}.`);
  if (opts.json) return printJson({ ...data, apps: apps.map((a) => ({ ...a, deployments: a.deployments.slice(0, opts.limit) })) });

  apps.forEach((app, i) => {
    if (i) print();
    const where = app.fqdn ?? (app.branch ? `${app.branch} branch` : "");
    print(`${c.bold(app.name)}  ${STAGE_LABEL[app.stage]}  ${stateText(app)}${where ? `  ${c.dim(where)}` : ""}`);
    const recent = app.deployments.slice(0, opts.limit);
    if (!recent.length) return print(c.dim("  never deployed"));
    columns(
      recent.map((d): Cell[] => {
        const sha = d.commit?.slice(0, 7) ?? "";
        const took = duration(d.createdAt, d.updatedAt);
        const when = relativeTime(d.updatedAt);
        return [
          [d.status, statusText(d.status)],
          [sha, c.dim(sha)],
          [took, c.dim(took)],
          [when, c.dim(when)],
          [d.trigger, c.dim(d.trigger)],
          truncate((d.commitMessage ?? "").split("\n")[0] ?? "", 56),
        ];
      }),
    ).forEach((l) => print(l));
  });
  print(c.dim(`\n${data.instance!.url}`));
}

/* ------------------------------------------------------------------ */
/* oche envs                                                           */
/* ------------------------------------------------------------------ */

const ISSUE_LABEL: Record<Exclude<EnvIssue, null>, string> = {
  "missing-in-prod": "missing in production",
  "missing-in-staging": "missing in staging",
  "empty-value": "defined but empty",
  "same-secret": "same value in staging and production",
};

/** A key with nothing in it leaves the app running without the setting, so it reads as red, not as a note. */
const issueText = (issue: EnvIssue) =>
  issue === null ? "" : issue === "missing-in-prod" || issue === "empty-value" ? c.red(ISSUE_LABEL[issue]) : c.yellow(ISSUE_LABEL[issue]);

/**
 * The markers, spelled out. ∅ is the one that needs saying: a tick used to cover
 * an empty value too, which is how an empty TURNSTILE_SECRET read as configured
 * on all three stages while nothing was protecting production.
 */
function legend(): string {
  const set = `${c.green("✓")} ${c.dim("set")}`;
  const empty = `${c.red("∅")} ${c.dim("defined but empty, so the app sees nothing")}`;
  const absent = `${c.red("·")} ${c.dim("not defined")}`;
  return `${set}  ${empty}  ${absent}  ${c.dim("-  no app on that stage")}`;
}

/** Which stages define each variable, and which hold nothing. Values stay on the server; only names and matches are compared. */
export async function envsCommand(getClient: GetClient, repoArg: string | undefined, opts: { stage?: Stage; key?: string; json?: boolean }) {
  const repo = await resolveRepo(repoArg);
  const { groups } = await (await getClient()).envs(repo);
  const key = opts.key?.trim().toLowerCase();
  // --stage narrows the columns, not the rows: a variable missing from a stage is the thing worth seeing.
  const kept = groups
    .filter((g) => !opts.stage || g.apps[opts.stage])
    .map((g) => ({ ...g, rows: key ? g.rows.filter((r) => r.key.toLowerCase().includes(key)) : g.rows }));

  if (opts.json) return printJson({ groups: kept });
  if (!kept.some((g) => g.rows.length)) {
    const where = opts.stage ? ` on ${STAGE_LABEL[opts.stage]}` : "";
    print(key ? `No variable matching "${opts.key}"${where} on ${slug(repo)}.` : `No environment variables${where} on ${slug(repo)}'s Coolify apps.`);
    return;
  }

  kept.forEach((g, i) => {
    if (i) print();
    envGroupLines(g, opts.stage, !key).forEach((l) => print(l));
  });
  print(`\n${legend()}`);
  print(c.dim("Oche compares names, and whether staging and production hold the same value. It never shows values."));
}

/** One group's heading, table and totals. Returned rather than printed, so it can be read back in a test. */
export function envGroupLines(group: EnvComparison, only: Stage | undefined, totals: boolean): string[] {
  const stages = STAGES.filter((s) => group.apps[s] && (!only || s === only));
  const where = stages.map((s) => `${s}: ${group.apps[s]!.name}`).join(" · ");
  const header: Cell[] = [["VARIABLE", c.dim("VARIABLE")], ...stages.map((s): Cell => [s, c.dim(s)]), ""];
  const rows = group.rows.map((r): Cell[] => [
    r.key,
    ...stages.map((s): Cell => {
      if (r.present[s] === undefined) return ["-", c.dim("-")];
      if (!r.present[s]) return ["·", c.red("·")];
      // Defined and empty gets its own marker. The same tick as a configured key is what hid it.
      // Optional chain on purpose. A server older than this client sends no
      // hasValue at all, and reading it blind threw "Cannot read properties of
      // undefined" on every row, which broke the whole command rather than
      // degrading it. Unknown means "defined", the behaviour before this field.
      return r.hasValue?.[s] === false ? ["∅", c.red("∅")] : ["✓", c.green("✓")];
    }),
    issueText(r.issue),
  ]);
  const lines = [`${c.bold(group.label)}  ${c.dim(where)}`, ...columns([header, ...rows])];
  if (!totals) return lines;
  const { missingInProd, missingInStaging, emptyValue, sameSecret } = group.counts;
  const issues = [
    emptyValue ? c.red(`${emptyValue} defined but empty`) : "",
    missingInProd ? c.red(`${missingInProd} missing in production`) : "",
    missingInStaging ? c.yellow(`${missingInStaging} missing in staging`) : "",
    sameSecret ? c.yellow(`${sameSecret} shared with staging`) : "",
  ].filter(Boolean);
  lines.push(issues.length ? `  ${issues.join(c.dim(" · "))}` : c.dim("  in step across environments"));
  return lines;
}

/* ------------------------------------------------------------------ */
/* oche deploy / rollback                                              */
/* ------------------------------------------------------------------ */

export async function deployCommand(getClient: GetClient, repoArg: string | undefined, opts: AppOpts & { force?: boolean; yes?: boolean }) {
  const repo = await resolveRepo(repoArg);
  const api = await getClient();
  const app = pickApp(await coolifyApps(api, repo), opts);
  const what = opts.force ? "Rebuild" : "Redeploy";
  if (!opts.yes && !(await confirm(`${what} ${appLabel(app)} on ${slug(repo)}${opts.force ? ", ignoring the build cache" : ""}?`, app.stage !== "prod"))) {
    return print("Cancelled.");
  }
  const { deploymentUuid } = await api.deploy(repo, app.uuid, Boolean(opts.force));
  if (opts.json) return printJson({ app: { uuid: app.uuid, name: app.name, stage: app.stage }, deploymentUuid });
  ok(`${what === "Rebuild" ? "Rebuilding" : "Redeploying"} ${appLabel(app)}.`);
  print(c.dim(`  oche logs ${slug(repo)} --app ${app.name}${deploymentUuid ? ` --deployment ${deploymentUuid}` : " --build"}  follows the build`));
}

export async function rollbackCommand(getClient: GetClient, repoArg: string | undefined, opts: AppOpts & { to?: string; yes?: boolean }) {
  const repo = await resolveRepo(repoArg);
  const api = await getClient();
  const app = pickApp(await coolifyApps(api, repo), opts);
  const options = await api.rollbackOptions(repo, app.uuid);

  if (!opts.to) {
    if (opts.json) return printJson(options);
    print(`${c.bold(app.name)}  ${STAGE_LABEL[app.stage]}  ${c.dim(`currently ${options.current?.slice(0, 7) ?? "unknown"}`)}`);
    if (!options.images.length) {
      print(c.dim("  Coolify has no older images for this app."));
      return;
    }
    columns(
      options.images.map((i): Cell[] => {
        const when = relativeTime(i.deployedAt ?? i.createdAt);
        return [
          i.isCurrent ? ["now", c.green("now")] : "",
          i.tag.slice(0, 7),
          [when, c.dim(when)],
          truncate((i.commitMessage ?? "").split("\n")[0] ?? "", 48),
        ];
      }),
    ).forEach((l) => print(l));
    print(c.dim(`\nRoll back with \`oche rollback ${slug(repo)} --app ${app.name} --to <commit>\`.`));
    return;
  }

  const wanted = opts.to.trim().toLowerCase();
  const target = options.images.find((i) => i.tag.toLowerCase().startsWith(wanted) || wanted.startsWith(i.tag.toLowerCase()));
  if (!target) {
    throw new CliError(`Coolify has no image for ${opts.to} on ${appLabel(app)}. It still has: ${options.images.map((i) => i.tag.slice(0, 7)).join(", ") || "none"}.`);
  }
  const subject = truncate((target.commitMessage ?? "").split("\n")[0] ?? "", 48);
  if (!opts.yes && !(await confirm(`Roll ${appLabel(app)} on ${slug(repo)} back to ${target.tag.slice(0, 7)}${subject ? ` (${subject})` : ""}?`))) {
    return print("Cancelled.");
  }
  const { deploymentUuid } = await api.rollback(repo, app.uuid, target.tag);
  if (opts.json) return printJson({ app: options.app, commit: target.tag, deploymentUuid });
  ok(`Rolling ${appLabel(app)} back to ${target.tag.slice(0, 7)}.`);
  print(c.dim(`  oche deployments ${slug(repo)} --app ${app.name}  shows how it goes`));
}

/* ------------------------------------------------------------------ */
/* oche explain / preflight                                            */
/* ------------------------------------------------------------------ */

/** The newest failed deployment is almost always the one being asked about. */
const worthExplaining = (deployments: ApiDeployment[]) => deployments.find((d) => d.status === "failed") ?? deployments[0];

export async function explainCommand(getClient: GetClient, repoArg: string | undefined, opts: AppOpts & { deployment?: string }) {
  const repo = await resolveRepo(repoArg);
  const api = await getClient();
  const app = pickApp(await coolifyApps(api, repo), opts);
  const chosen = opts.deployment ? null : worthExplaining(app.deployments);
  const deploymentUuid = opts.deployment ?? chosen?.uuid;
  if (!deploymentUuid) throw new CliError(`${appLabel(app)} has no deployments on Coolify yet.`);
  if (chosen && chosen.status !== "failed") note(`The last deployment of ${appLabel(app)} ${chosen.status === "finished" ? "worked" : `is ${chosen.status}`}; explaining it anyway.`);

  note(`Reading the build log of ${appLabel(app)} and asking the model…`);
  const { explanation } = await api.explainDeployment(repo, app.uuid, deploymentUuid);
  if (opts.json) return printJson({ app: { uuid: app.uuid, name: app.name, stage: app.stage }, deployment: deploymentUuid, explanation });
  print(explanation.trim());
}

export async function preflightCommand(getClient: GetClient, repoArg: string | undefined, opts: { to: "staging" | "prod"; json?: boolean }) {
  const repo = await resolveRepo(repoArg);
  const data = await (await getClient()).preflight(repo, opts.to);
  if (opts.json) return printJson(data);
  if (!data.linked) {
    print(`${slug(repo)} isn't linked to a Coolify instance, so there's nothing to check before promoting.`);
    return;
  }

  print(`${c.bold(`Before promoting to ${STAGE_LABEL[opts.to]}`)}  ${c.dim(slug(repo))}`);
  print();
  print(c.bold("Environment variables"));
  if (!data.envIssues.length) print(c.dim("  in step across environments"));
  for (const issue of data.envIssues) {
    if (issue.missing.length) print(`  ${c.red("·")} ${issue.app}: ${plural(issue.missing.length, "variable")} missing — ${issue.missing.join(", ")}`);
    if (issue.shared.length) print(`  ${c.yellow("·")} ${issue.app}: shared with staging — ${issue.shared.join(", ")}`);
  }

  const below = data.below;
  print();
  print(c.bold(below ? `The ${below.stage} stage` : "The stage below"));
  if (!below || !below.apps) print(c.dim("  no apps deploying there"));
  else if (!below.unhealthy.length) print(`  ${c.green("✓")} ${plural(below.apps, "app")} healthy`);
  else for (const a of below.unhealthy) print(`  ${c.red("·")} ${a.name}: ${a.state}${a.status ? ` · last deployment ${a.status}` : ""}`);

  const blocking = data.envIssues.some((i) => i.missing.length) || Boolean(below?.unhealthy.length);
  print();
  print(blocking ? c.yellow("Sort these out before promoting, or promote knowing about them.") : c.green("Nothing in the way."));
}
