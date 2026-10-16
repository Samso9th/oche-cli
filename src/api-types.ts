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
  | "coolify-setup";

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
}

export type WorkMergeMethod = "merge" | "squash" | "rebase";

export interface ApiEvent {
  id: number;
  repo: string;
  type: EventType;
  summary: string;
  actor: string | null;
  prNumber: number | null;
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

export type ApiError = { error: string };
