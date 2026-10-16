/**
 * Pure helpers for `oche ship`: the confirmation plan (a mirror of the
 * server's planSteps in services/ship-runs.ts) and the lines to print as a
 * ship run's steps change.
 */
import type { ApiRepo, RunStep, ShipTarget, WorkMergeMethod } from "./api-types.ts";
import { c, plural } from "./ui.ts";

const MERGE_HOW: Record<WorkMergeMethod, string> = {
  merge: "open a PR and merge",
  squash: "open a PR and squash-merge",
  rebase: "open a PR and rebase-merge",
};

export const STAGING_WAIT = "wait for staging to deploy healthy on Coolify";
export const PROD_WAIT = "wait for production to deploy healthy";

/** The hops a ship makes, in order. Same as shipPlan on the server. */
export function shipHops(branches: NonNullable<ApiRepo["branches"]>, from: string, target: ShipTarget, direct: boolean) {
  const hops: { head: string; base: string }[] = [];
  if (from !== branches.dev) hops.push({ head: from, base: branches.dev });
  if (target === "staging" || (target === "prod" && !direct)) hops.push({ head: branches.dev, base: branches.staging });
  if (target === "prod") hops.push(direct ? { head: branches.dev, base: branches.prod } : { head: branches.staging, base: branches.prod });
  return hops;
}

type PlanRepo = Pick<ApiRepo, "branches" | "mode" | "requiredApprovals" | "workMergeMethod" | "gateOnStaging" | "coolifyLinked">;

/** One line per step the server will run, with Coolify waits exactly where planSteps puts them. */
export function planLines(repo: PlanRepo, branch: string, target: ShipTarget, direct: boolean): string[] {
  const b = repo.branches!;
  const review = repo.mode === "strict" ? c.yellow(` (needs ${plural(repo.requiredApprovals, "approval")})`) : "";
  const hops = shipHops(b, branch, target, direct);
  const toProd = hops.some((h) => h.base === b.prod);
  const lines: string[] = [];
  for (const h of hops) {
    const arrow = `${h.head} → ${h.base}`;
    if (h.base === b.dev) lines.push(`${arrow}${c.dim(`  ${MERGE_HOW[repo.workMergeMethod] ?? MERGE_HOW.squash}`)}${review}`);
    else if (h.head === b.dev && h.base === b.prod) lines.push(`${arrow}${c.dim(`  then Oche merges ${b.prod} into ${b.staging}`)}${review}`);
    else lines.push(`${arrow}${review}`);

    if (!repo.coolifyLinked) continue;
    if (h.base === b.staging && toProd && repo.gateOnStaging) lines.push(STAGING_WAIT);
    if (h.base === b.prod) lines.push(PROD_WAIT);
    if (h.base === b.staging && !toProd) lines.push(STAGING_WAIT);
  }
  return lines;
}

/** How a step looks right now. Pending steps print nothing. */
export function stepLines(step: RunStep): string[] {
  const detail = step.detail ? `  ${step.detail}` : "";
  const pr = step.pr ? `    → ${step.pr.url}` : null;
  switch (step.status) {
    case "pending":
      return [];
    case "running":
      return [c.dim(`… ${step.label}${step.kind === "wait" ? detail : ""}`)];
    case "done":
      return [`${c.green("✓")} ${step.label}${step.pr ? `  ${c.dim(`#${step.pr.number}`)}` : ""}`];
    case "skipped":
      return [`${c.dim("·")} ${step.label}${step.detail ? `  ${c.dim(step.detail)}` : ""}`];
    case "waiting-review":
      return [`${c.yellow("…")} ${step.label}  waiting for review${step.detail ? `: ${step.detail}` : ""}`, ...(pr ? [pr] : [])];
    case "failed":
      return [`${c.red("✗")} ${step.label}${detail}`, ...(pr ? [pr] : [])];
  }
}

/**
 * Lines for the steps that changed between two polls of a run: a new status,
 * or new progress text on a wait step that's still running. Unchanged steps
 * print nothing.
 */
export function stepUpdates(prev: RunStep[], next: RunStep[]): string[] {
  const before = new Map(prev.map((s) => [s.id, s]));
  const lines: string[] = [];
  for (const step of next) {
    const old = before.get(step.id);
    const changed =
      !old ||
      old.status !== step.status ||
      (step.status === "running" && step.kind === "wait" && (old.detail ?? "") !== (step.detail ?? ""));
    if (changed) lines.push(...stepLines(step));
  }
  return lines;
}
