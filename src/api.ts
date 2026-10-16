import type {
  AppLogs,
  CommitMessageRequest,
  CommitMessageResponse,
  DeploymentDetail,
  DeployResponse,
  EnvsResponse,
  ExplainResponse,
  Preflight,
  RepoDeploymentsResponse,
  RollbackOptions,
  ShipRequest,
  ShipResponse,
  ShipRunResponse,
  ApiError,
  EventsResponse,
  MeResponse,
  OnboardRequest,
  OnboardResponse,
  PromoteRequest,
  PromoteResponse,
  Promotion,
  RepoResponse,
  ReposResponse,
  UpdateRepoRequest,
  UpdateRepoResponse,
} from "./api-types.ts";
import pkg from "../package.json" with { type: "json" };
import type { Source } from "./config.ts";
import { ApiRequestError, CliError } from "./errors.ts";
import type { RepoSlug } from "./git.ts";

const TIMEOUT_MS = 60_000;

const repoPath = (r: RepoSlug) => `/v1/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;

export class Client {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly tokenSource: Source = "config",
  ) {}

  me() {
    return this.request<MeResponse>("GET", "/v1/me");
  }

  repos() {
    return this.request<ReposResponse>("GET", "/v1/repos");
  }

  repo(r: RepoSlug) {
    return this.request<RepoResponse>("GET", repoPath(r));
  }

  onboard(r: RepoSlug, dryRun: boolean) {
    return this.request<OnboardResponse>("POST", `${repoPath(r)}/onboard`, { dryRun } satisfies OnboardRequest);
  }

  promote(r: RepoSlug, to: Promotion) {
    return this.request<PromoteResponse>("POST", `${repoPath(r)}/promote`, { to } satisfies PromoteRequest);
  }

  updateRepo(r: RepoSlug, body: UpdateRepoRequest) {
    return this.request<UpdateRepoResponse>("PATCH", repoPath(r), body);
  }

  /** Starts a ship run on the server (HTTP 202) and returns right away; follow it with shipRun(). */
  ship(r: RepoSlug, body: ShipRequest) {
    return this.request<ShipResponse>("POST", `${repoPath(r)}/ship`, body);
  }

  shipRun(id: number) {
    return this.request<ShipRunResponse>("GET", `/v1/ship-runs/${id}`);
  }

  cancelShipRun(id: number) {
    return this.request<ShipRunResponse>("POST", `/v1/ship-runs/${id}/cancel`);
  }

  /** The server writes it with the model it's configured for, so the CLI needs no AI key. */
  commitMessage(body: CommitMessageRequest) {
    return this.request<CommitMessageResponse>("POST", "/v1/ai/commit-message", body, 90_000);
  }

  /* ---- Coolify ---- */

  deployments(r: RepoSlug) {
    return this.request<RepoDeploymentsResponse>("GET", `${repoPath(r)}/deployments`);
  }

  /** One deployment with its build log, the failure excerpt and a pasteable report. */
  deployment(r: RepoSlug, app: string, deployment: string) {
    return this.request<DeploymentDetail>("GET", `${repoPath(r)}/deployments/${encodeURIComponent(app)}/${encodeURIComponent(deployment)}`);
  }

  /** The running container's log, not the build log. */
  appLogs(r: RepoSlug, app: string, lines: number) {
    return this.request<AppLogs>("GET", `${repoPath(r)}/apps/${encodeURIComponent(app)}/logs?lines=${lines}`);
  }

  /** The server asks its AI model what broke, so the CLI needs no AI key. */
  explainDeployment(r: RepoSlug, app: string, deployment: string) {
    const path = `${repoPath(r)}/deployments/${encodeURIComponent(app)}/${encodeURIComponent(deployment)}/explain`;
    return this.request<ExplainResponse>("POST", path, undefined, 120_000);
  }

  deploy(r: RepoSlug, app: string, force: boolean) {
    return this.request<DeployResponse>("POST", `${repoPath(r)}/apps/${encodeURIComponent(app)}/deploy`, { force });
  }

  rollbackOptions(r: RepoSlug, app: string) {
    return this.request<RollbackOptions>("GET", `${repoPath(r)}/apps/${encodeURIComponent(app)}/rollback`);
  }

  rollback(r: RepoSlug, app: string, commit: string) {
    return this.request<DeployResponse>("POST", `${repoPath(r)}/apps/${encodeURIComponent(app)}/rollback`, { commit });
  }

  envs(r: RepoSlug) {
    return this.request<EnvsResponse>("GET", `${repoPath(r)}/envs`);
  }

  preflight(r: RepoSlug, to: "staging" | "prod") {
    return this.request<Preflight>("GET", `${repoPath(r)}/preflight?to=${to}`);
  }

  events(repo: RepoSlug | null, limit: number) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (repo) q.set("repo", `${repo.owner}/${repo.repo}`);
    return this.request<EventsResponse>("GET", `/v1/events?${q}`);
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          "user-agent": `oche-cli/${pkg.version}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (e) {
      throw networkError(e, this.baseUrl, timeoutMs);
    }

    const text = await res.text().catch(() => "");
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = undefined;
    }
    const serverMessage =
      data && typeof data === "object" && typeof (data as ApiError).error === "string" ? (data as ApiError).error : null;

    if (res.status === 401) {
      throw new ApiRequestError(
        this.tokenSource === "env"
          ? "OCHE_TOKEN was rejected (401). Fix it, or unset it and run `oche login`."
          : "Not logged in, or the token was revoked (401). Run `oche login`.",
        401,
      );
    }
    if (!res.ok) {
      const detail = serverMessage ?? (data === undefined ? `unexpected response from ${url}` : res.statusText);
      throw new ApiRequestError(`${detail} (HTTP ${res.status})`, res.status);
    }
    if (data === undefined || data === null) {
      throw new CliError(`Unexpected response from ${url} (HTTP ${res.status}). Is ${this.baseUrl} an Oche server?`);
    }
    return data as T;
  }
}

function networkError(e: unknown, baseUrl: string, timeoutMs = TIMEOUT_MS): CliError {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError") {
    return new CliError(`Request to ${baseUrl} timed out after ${timeoutMs / 1000}s.`);
  }
  const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
  if (/redirect/i.test(reason)) {
    return new CliError(`${baseUrl} redirected the request. Use the server's final URL (e.g. https://).`);
  }
  return new CliError(`Couldn't reach ${baseUrl} (${reason}).`);
}
