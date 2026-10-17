/**
 * Mirror of server/src/core/api.ts. Keep in sync.
 *
 * The HTTP contract between the Oche server and its clients. All routes live
 * under /v1 and take `Authorization: Bearer <token>`. Errors come back as
 * { error: string } with a 4xx/5xx status. Type declarations only: nothing
 * here exists at runtime.
 */

/* ---- from flow.ts ------------------------------------------------- */

export type Mode = "fast" | "strict";

export interface Branches {
  prod: string;
  staging: string;
  dev: string;
}

export type Stage = "prod" | "staging" | "dev";

export type MoveKind =
  | "feature" // any work branch → dev
  | "promote-staging" // dev → staging
  | "promote-prod" // staging → prod
  | "skip-staging" // dev → prod
  | "sync-staging" // prod (or an oche/sync/* branch) → staging, opened by Oche
  | "unmanaged"; // base isn't one of the three branches

export interface ApprovalStatus {
  approvals: number;
  required: number;
  changesRequested: boolean;
  satisfied: boolean;
}

/** The promotions a person can ask for from the dashboard or CLI. */
export type Promotion = "staging" | "prod" | "prod-direct";

/* ---- from github.ts ----------------------------------------------- */

export type EventType =
  | "onboarded"
  | "branch-created"
  | "promoted"
  | "promotion-waiting"
  | "promotion-conflict"
  | "synced"
  | "sync-conflict"
  | "pr-blocked"
  | "pr-retargeted"
  | "branch-restored"
  | "direct-push"
  | "mode-changed"
  | "deploy-succeeded"
  | "deploy-failed"
  | "deploy-triggered"
  | "app-stopped"
  | "coolify-setup"
  | "rolled-back"
  | "settings-changed"
  | "published"
  | "publish-failed"
  | "publish-setup";

export interface OcheEvent {
  type: EventType;
  summary: string;
  prNumber?: number;
  data?: Record<string, unknown>;
}

export interface OnboardingPlan {
  branches: Branches;
  prodSha: string;
  defaultBranch: string;
  steps: { id: string; label: string; done: boolean }[];
}

export interface BranchHead {
  name: string;
  sha: string;
  message: string;
  author: string | null;
  avatarUrl: string | null;
  date: string | null;
}

export interface OpenPromotion {
  number: number;
  title: string;
  head: string;
  base: string;
  url: string;
  kind: MoveKind;
}

export interface OpenWork {
  number: number;
  title: string;
  head: string;
  url: string;
  author: string | null;
  draft: boolean;
}

export interface RepoStatus {
  heads: Partial<Record<Stage, BranchHead>>;
  /** Open PRs from work branches into dev: the ones a ship can start from. */
  openWork: OpenWork[];
  /** Commits waiting to move up a stage. */
  pending: { staging: number; prod: number; prodDirect: number };
  openPromotions: OpenPromotion[];
  blockedPullRequests: number;
}

export interface PrSummary {
  number: number;
  url: string;
  title: string;
  head: string;
  base: string;
}

export type PromoteResult =
  | { status: "merged"; pr: PrSummary; events: OcheEvent[] }
  | { status: "waiting-review"; pr: PrSummary; approval: ApprovalStatus; events: OcheEvent[] }
  | { status: "nothing-to-promote"; events: OcheEvent[] }
  | { status: "conflict"; pr: PrSummary; events: OcheEvent[] }
  | { status: "blocked"; reason: string; events: OcheEvent[] };

/* ---- api.ts ------------------------------------------------------- */

export interface ApiUser {
  login: string;
  avatarUrl: string | null;
  role: "owner" | "member";
}

export interface ApiRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  /** True once onboarded; Oche only guards and promotes managed repos. */
  managed: boolean;
  mode: Mode;
  requiredApprovals: number;
  branches: Branches | null;
  htmlUrl: string;
  /** How work-branch PRs land in dev. */
  workMergeMethod: WorkMergeMethod;
  /** Production waits for staging to deploy healthy on Coolify. */
  gateOnStaging: boolean;
  coolifyLinked: boolean;
  /** npm publishing, when it's set up. */
  npm: ApiRepoNpm | null;
}

export interface ApiRepoNpm {
  packageName: string;
  enabled: boolean;
  lastVersion: string | null;
  /** The last publish run failed. */
  failing: boolean;
}

export type WorkMergeMethod = "merge" | "squash" | "rebase";

export interface ApiEvent {
  id: number;
  repo: string;
  type: EventType;
  summary: string;
  actor: string | null;
  prNumber: number | null;
  /** Where to look: the Actions run, the npm page. */
  url: string | null;
  createdAt: string;
}

/** GET /v1/me */
export type MeResponse = ApiUser;

/** GET /v1/repos */
export type ReposResponse = { repos: ApiRepo[] };

/** GET /v1/repos/:owner/:repo */
export type RepoResponse = { repo: ApiRepo; status: RepoStatus | null; events: ApiEvent[] };

/** POST /v1/repos/:owner/:repo/onboard  body: { dryRun?: boolean } */
export type OnboardRequest = { dryRun?: boolean };
export type OnboardResponse = { plan: OnboardingPlan; applied: boolean; repo: ApiRepo };

/** POST /v1/repos/:owner/:repo/promote  body: { to } */
export type PromoteRequest = { to: Promotion };
/**
 * PromoteResult minus `events`, per variant. A plain Omit<Union, K> collapses
 * the union to its shared keys ({ status }) and loses pr/approval/reason.
 */
export type PromoteResponse = PromoteResult extends infer R ? (R extends unknown ? Omit<R, "events"> : never) : never;

/** PATCH /v1/repos/:owner/:repo (owners only) */
export type UpdateRepoRequest = {
  mode?: Mode;
  requiredApprovals?: number;
  workMergeMethod?: WorkMergeMethod;
  gateOnStaging?: boolean;
  branches?: Partial<Branches>;
};
export type UpdateRepoResponse = { repo: ApiRepo };

/** GET /v1/events?repo=owner/name&limit=50 */
export type EventsResponse = { events: ApiEvent[] };

/* ---- ship ---- */

export type ShipTarget = "dev" | "staging" | "prod";

/** POST /v1/repos/:owner/:repo/ship. Merges `from` into dev if it's a work branch, then promotes up to `to`. */
export interface ShipRequest {
  from?: string;
  to: ShipTarget;
  /** Skip staging: dev → main, then Oche syncs staging. */
  direct?: boolean;
}

/* from services/ship-runs.ts */

export type StepStatus = "pending" | "running" | "done" | "skipped" | "waiting-review" | "failed";

export interface RunStep {
  id: string;
  kind: "merge" | "wait";
  label: string;
  head?: string;
  base?: string;
  stage?: Stage;
  status: StepStatus;
  detail?: string;
  pr?: PrSummary;
  /** For wait steps: each app's deployment as Oche last saw it. */
  apps?: { uuid: string; name: string; state: "waiting" | "building" | "healthy" | "failed" | "unhealthy"; deploymentUuid?: string }[];
  startedAt?: string;
  finishedAt?: string;
}

export type ShipRunStatus = "running" | "succeeded" | "failed" | "stopped" | "cancelled";

export interface ApiShipRun {
  id: number;
  repo: string;
  actor: string;
  status: ShipRunStatus;
  request: ShipRequest;
  steps: RunStep[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** POST /v1/repos/:owner/:repo/ship → 202 { run }. 409 when a ship is already running on the repo. */
export type ShipResponse = { run: ApiShipRun };

/** GET /v1/ship-runs/:id and POST /v1/ship-runs/:id/cancel → { run } */
export type ShipRunResponse = { run: ApiShipRun };

/** GET /v1/repos/:owner/:repo/ship-runs?limit=5 */
export type ShipRunsResponse = { runs: ApiShipRun[] };

/** POST /v1/ai/commit-message → { message }. 503 when the server has no OpenRouter key. */
export type CommitMessageRequest = { diff: string; stat: string; recent: string[]; branch?: string };
export type CommitMessageResponse = { message: string };

/* ---- Coolify (mirrors server/src/services/coolify.ts and server/src/coolify/*) ---- */

export interface ApiCoolifyInstance {
  id: number;
  name: string;
  url: string;
  version: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Blank for members: the URL carries a secret. */
  webhookUrl: string;
  cloudflareAccess: boolean;
  /** Coolify's team webhook: pointing at Oche ("on"), unset ("off"), or used by something else ("other"). */
  alerts: "on" | "off" | "other" | null;
  appCount: number | null;
  linkedRepos: number;
}

export interface ApiDeployment {
  uuid: string;
  /** queued | in_progress | finished | failed | cancelled-by-user */
  status: string;
  commit: string | null;
  commitMessage: string | null;
  createdAt: string;
  updatedAt: string;
  trigger: "webhook" | "api" | "manual";
  forceRebuild: boolean;
}

export interface ApiCoolifyApp {
  uuid: string;
  name: string;
  stage: Stage;
  branch: string | null;
  fqdn: string | null;
  state: string;
  health: string | null;
  buildPack: string | null;
  baseDirectory: string | null;
  deployments: ApiDeployment[];
  coolifyUrl: string;
}

/** GET /v1/repos/:owner/:repo/deployments */
export interface RepoDeploymentsResponse {
  instance: ApiCoolifyInstance | null;
  apps: ApiCoolifyApp[];
  otherBranches: { uuid: string; name: string; branch: string | null }[];
  /** When nothing matched: apps building a repo with the same name under another owner. */
  sameName: { uuid: string; name: string; repo: string | null; branch: string | null }[];
}

export interface LogLine {
  output: string;
  type: "stdout" | "stderr";
  /** Coolify hides lines that can hold secrets. Never print them. */
  hidden: boolean;
  command?: string | null;
  timestamp?: string | null;
}

/** GET /v1/repos/:owner/:repo/deployments/:app/:deployment */
export interface DeploymentDetail {
  deployment: ApiDeployment;
  app: { uuid: string; name: string; stage: Stage; fqdn: string | null };
  lines: LogLine[];
  /** The errors and the tail, hidden lines left out. */
  excerpt: string[];
  report: string;
}

/** GET /v1/repos/:owner/:repo/apps/:app/logs?lines=200 — the running container's log. */
export interface AppLogs {
  app: { uuid: string; name: string; stage: Stage; fqdn: string | null; state: string; health: string | null };
  lines: LogLine[];
  excerpt: string[];
}

/** POST /v1/repos/:owner/:repo/deployments/:app/:deployment/explain (AI) */
export type ExplainResponse = { explanation: string };

/** POST /v1/repos/:owner/:repo/apps/:app/deploy  body: { force?: boolean } */
export type DeployResponse = { deploymentUuid: string | null };

/** GET /v1/repos/:owner/:repo/apps/:app/rollback. POST the same path with { commit }. */
export interface RollbackOptions {
  app: { uuid: string; name: string; stage: Stage };
  current: string | null;
  images: { tag: string; createdAt: string; isCurrent: boolean; commitMessage: string | null; deployedAt: string | null }[];
}

export type EnvIssue = "missing-in-prod" | "missing-in-staging" | "same-secret" | null;

/** Names and whether two stages share a value. Values never leave the server. */
export interface EnvRow {
  key: string;
  present: Partial<Record<Stage, boolean>>;
  sameStagingProd: boolean;
  issue: EnvIssue;
}

export interface EnvComparison {
  label: string;
  apps: Partial<Record<Stage, { uuid: string; name: string }>>;
  rows: EnvRow[];
  counts: { missingInProd: number; missingInStaging: number; sameSecret: number };
}

/** GET /v1/repos/:owner/:repo/envs */
export type EnvsResponse = { groups: EnvComparison[] };

/** GET /v1/repos/:owner/:repo/preflight?to=prod */
export interface Preflight {
  linked: boolean;
  envIssues: { app: string; missing: string[]; shared: string[] }[];
  below: { stage: Stage; apps: number; unhealthy: { name: string; status: string | null; state: string }[] } | null;
}

export type ApiError = { error: string };

/* ---- npm publishing (from api.ts) -------------------------------- */

export type NpmLockfile = "npm" | "pnpm" | "yarn" | "yarn-berry" | "none";

export interface NpmStep {
  id: "permissions" | "workflow" | "on-prod" | "trust" | "published";
  label: string;
  done: boolean;
  hint?: string;
}

/** GET /v1/repos/:owner/:repo/npm */
export interface NpmStatusResponse {
  detected: {
    found: boolean;
    name: string | null;
    version: string | null;
    private: boolean;
    workspaces: boolean;
    lockfile: NpmLockfile;
    hasTests: boolean;
    otherPublishers: string[];
  };
  /** Why Oche can't publish this repo, if it can't. */
  blocked: string | null;
  registry: { exists: boolean; latest: string | null; publishedAt: string | null; url: string } | null;
  publishing: {
    packageName: string;
    enabled: boolean;
    runTests: boolean;
    trustedAt: string | null;
    trustedBy: string | null;
    setupPr: { number: number; url: string } | null;
    lastRun: { url: string; conclusion: string; at: string; failedStep: string | null } | null;
    lastVersion: string | null;
    lastPublishedAt: string | null;
    /** The workflow on the dev branch differs from what Oche would write now. */
    outdated: boolean;
  } | null;
  workflowOnProd: boolean;
  permissions: { ok: boolean; missing: string[]; fixUrl: string | null };
  /** The command to run locally so npm trusts the workflow. */
  trustCommand: string | null;
  steps: NpmStep[];
}

/** POST /v1/repos/:owner/:repo/npm  { dryRun?, force? } → the workflow and, unless dry, the PR. */
export type NpmSetupRequest = { dryRun?: boolean; force?: boolean };
export interface NpmSetupResponse {
  workflow: string;
  path: string;
  branch: string;
  pr: { number: number; url: string; merged: boolean } | null;
}

/** PATCH /v1/repos/:owner/:repo/npm */
export type NpmUpdateRequest = { enabled?: boolean; runTests?: boolean };

/** POST /v1/repos/:owner/:repo/npm/trust, sent by `oche npm setup` once `npm trust` succeeded. */
export type NpmTrustRequest = { packageName: string; npmUser: string };

/** DELETE /v1/repos/:owner/:repo/npm?removeWorkflow=1 → the PR that removes the workflow, if asked. */
export type NpmRemoveResponse = { pr: { number: number; url: string } | null };
