import { describe, expect, it } from "vitest";
import type { ApiCoolifyApp, RepoDeploymentsResponse, Stage } from "../src/api-types.ts";
import { pickApp } from "../src/coolify.ts";
import { duration } from "../src/ui.ts";

const app = (name: string, stage: Stage, uuid: string): ApiCoolifyApp => ({
  uuid,
  name,
  stage,
  branch: null,
  fqdn: null,
  state: "running",
  health: "healthy",
  buildPack: null,
  baseDirectory: null,
  deployments: [],
  coolifyUrl: "https://coolify.example.com",
});

const data = {
  instance: null,
  apps: [app("api", "prod", "aaa111"), app("apidev", "dev", "bbb222"), app("sandbox", "staging", "ccc333")],
  otherBranches: [],
  sameName: [],
} satisfies RepoDeploymentsResponse;

describe("pickApp", () => {
  it("picks by stage, by name and by the start of a uuid", () => {
    expect(pickApp(data, { stage: "prod" }).name).toBe("api");
    expect(pickApp(data, { app: "SANDBOX" }).uuid).toBe("ccc333");
    expect(pickApp(data, { app: "bbb" }).name).toBe("apidev");
  });

  it("asks which one when the repo has several", () => {
    expect(() => pickApp(data, {})).toThrow(/Several apps match/);
    expect(() => pickApp(data, { app: "api", stage: "dev" })).toThrow(/Nothing matches --app api --stage dev/);
  });

  it("needs no flag when there is only one app", () => {
    expect(pickApp({ ...data, apps: [data.apps[0]!] }, {}).name).toBe("api");
  });
});

describe("duration", () => {
  it("reads as long as it took", () => {
    expect(duration("2026-10-16T10:00:00Z", "2026-10-16T10:00:48Z")).toBe("48s");
    expect(duration("2026-10-16T10:00:00Z", "2026-10-16T10:02:11Z")).toBe("2m 11s");
    expect(duration("2026-10-16T10:00:00Z", "2026-10-16T11:04:00Z")).toBe("1h 4m");
    expect(duration("2026-10-16T10:00:00Z", null)).toBe("");
  });
});
