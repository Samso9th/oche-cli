import { beforeAll, describe, expect, it } from "vitest";
import type { ApiRepo, RunStep } from "../src/api-types.ts";
import { settingsLine } from "../src/commands.ts";
import { planLines, PROD_WAIT, STAGING_WAIT, stepUpdates } from "../src/ship-run.ts";

// Colors are read per call, so plain text from here on.
beforeAll(() => {
  process.env.NO_COLOR = "1";
});

const repo = (over: Partial<ApiRepo> = {}) =>
  ({
    branches: { prod: "main", staging: "staging", dev: "dev" },
    mode: "fast",
    requiredApprovals: 0,
    workMergeMethod: "squash",
    gateOnStaging: true,
    coolifyLinked: false,
    ...over,
  }) as ApiRepo;

describe("planLines", () => {
  it("says how the work branch lands in dev", () => {
    expect(planLines(repo({ workMergeMethod: "merge" }), "feat/x", "dev", false)).toEqual(["feat/x → dev  open a PR and merge"]);
    expect(planLines(repo({ workMergeMethod: "squash" }), "feat/x", "dev", false)).toEqual(["feat/x → dev  open a PR and squash-merge"]);
    expect(planLines(repo({ workMergeMethod: "rebase" }), "feat/x", "dev", false)).toEqual(["feat/x → dev  open a PR and rebase-merge"]);
  });

  it("has no Coolify waits when the repo isn't linked", () => {
    expect(planLines(repo(), "feat/x", "prod", false)).toEqual([
      "feat/x → dev  open a PR and squash-merge",
      "dev → staging",
      "staging → main",
    ]);
  });

  it("gates production on staging, then waits for production", () => {
    expect(planLines(repo({ coolifyLinked: true }), "dev", "prod", false)).toEqual([
      "dev → staging",
      STAGING_WAIT,
      "staging → main",
      PROD_WAIT,
    ]);
  });

  it("skips the staging gate when gateOnStaging is off", () => {
    expect(planLines(repo({ coolifyLinked: true, gateOnStaging: false }), "dev", "prod", false)).toEqual([
      "dev → staging",
      "staging → main",
      PROD_WAIT,
    ]);
  });

  it("waits for staging when staging is the target, gate or not", () => {
    for (const gateOnStaging of [true, false]) {
      expect(planLines(repo({ coolifyLinked: true, gateOnStaging }), "feat/x", "staging", false)).toEqual([
        "feat/x → dev  open a PR and squash-merge",
        "dev → staging",
        STAGING_WAIT,
      ]);
    }
  });

  it("goes straight to production with --direct", () => {
    expect(planLines(repo({ coolifyLinked: true }), "dev", "prod", true)).toEqual([
      "dev → main  then Oche merges main into staging",
      PROD_WAIT,
    ]);
  });

  it("notes required approvals in strict mode", () => {
    expect(planLines(repo({ mode: "strict", requiredApprovals: 2 }), "dev", "staging", false)).toEqual(["dev → staging (needs 2 approvals)"]);
  });
});

const merge = (over: Partial<RunStep> = {}): RunStep => ({ id: "merge-0", kind: "merge", label: "dev → staging", status: "pending", ...over });
const wait = (over: Partial<RunStep> = {}): RunStep => ({
  id: "wait-staging",
  kind: "wait",
  stage: "staging",
  label: "Staging deploys and is healthy",
  status: "pending",
  ...over,
});
const pr = { number: 7, url: "https://github.com/o/r/pull/7", title: "Promote", head: "dev", base: "staging" };

describe("stepUpdates", () => {
  it("prints nothing for pending or unchanged steps", () => {
    expect(stepUpdates([], [merge(), wait()])).toEqual([]);
    const running = [merge({ status: "running" }), wait()];
    expect(stepUpdates(running, running)).toEqual([]);
  });

  it("prints a step when its status changes", () => {
    expect(stepUpdates([merge(), wait()], [merge({ status: "running" }), wait()])).toEqual(["… dev → staging"]);
    expect(stepUpdates([merge({ status: "running" })], [merge({ status: "done", pr })])).toEqual(["✓ dev → staging  #7"]);
  });

  it("catches up on steps that moved several states between polls", () => {
    expect(stepUpdates([merge(), wait()], [merge({ status: "done", pr }), wait({ status: "running", detail: "api waiting to start" })])).toEqual([
      "✓ dev → staging  #7",
      "… Staging deploys and is healthy  api waiting to start",
    ]);
  });

  it("reprints a running wait step only when its progress text changes", () => {
    const a = wait({ status: "running", detail: "api building, worker building" });
    const b = wait({ status: "running", detail: "api building, worker healthy" });
    expect(stepUpdates([a], [a])).toEqual([]);
    expect(stepUpdates([a], [b])).toEqual(["… Staging deploys and is healthy  api building, worker healthy"]);
  });

  it("ignores detail changes on running merge steps", () => {
    expect(stepUpdates([merge({ status: "running" })], [merge({ status: "running", detail: "x" })])).toEqual([]);
  });

  it("formats skipped, waiting-review and failed steps", () => {
    expect(stepUpdates([], [merge({ status: "skipped", detail: "staging already has everything in dev" })])).toEqual([
      "· dev → staging  staging already has everything in dev",
    ]);
    expect(stepUpdates([], [merge({ status: "waiting-review", detail: "0 of 1 approvals", pr })])).toEqual([
      "… dev → staging  waiting for review: 0 of 1 approvals",
      `    → ${pr.url}`,
    ]);
    expect(stepUpdates([], [merge({ status: "failed", detail: "Merge conflicts.", pr })])).toEqual([
      "✗ dev → staging  Merge conflicts.",
      `    → ${pr.url}`,
    ]);
    expect(stepUpdates([], [wait({ status: "failed", detail: "api failed" })])).toEqual(["✗ Staging deploys and is healthy  api failed"]);
  });
});

describe("settingsLine", () => {
  it("shows the merge method, and the staging gate only when Coolify is linked", () => {
    expect(settingsLine({ workMergeMethod: "merge", gateOnStaging: true, coolifyLinked: false })).toBe("work PRs: merge");
    expect(settingsLine({ workMergeMethod: "squash", gateOnStaging: true, coolifyLinked: true })).toBe(
      "work PRs: squash · production waits for staging: yes (Coolify linked)",
    );
    expect(settingsLine({ workMergeMethod: "rebase", gateOnStaging: false, coolifyLinked: true })).toBe(
      "work PRs: rebase · production waits for staging: no (Coolify linked)",
    );
    expect(settingsLine({})).toBeNull();
  });
});
