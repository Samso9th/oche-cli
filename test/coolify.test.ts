import { describe, expect, it } from "vitest";
import type { ApiCoolifyApp, EnvComparison, EnvRow, RepoDeploymentsResponse, Stage } from "../src/api-types.ts";
import { envGroupLines, pickApp } from "../src/coolify.ts";
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

describe("envGroupLines", () => {
  const row = (key: string, present: EnvRow["present"], hasValue: EnvRow["hasValue"], issue: EnvRow["issue"] = null): EnvRow => ({
    key,
    present,
    hasValue,
    sameStagingProd: false,
    issue,
  });

  const group = (rows: EnvRow[], counts: Partial<EnvComparison["counts"]> = {}): EnvComparison => ({
    label: "api",
    apps: { dev: { uuid: "d", name: "apidev" }, staging: { uuid: "s", name: "sandbox" }, prod: { uuid: "p", name: "api" } },
    rows,
    counts: { missingInProd: 0, missingInStaging: 0, emptyValue: 0, sameSecret: 0, ...counts },
  });

  const cells = (line: string) => line.trim().split(/\s+/);

  it("marks a defined but empty key apart from a set one, a missing one and a stage with no app", () => {
    const lines = envGroupLines(
      group([
        row("SET", { dev: true, staging: true, prod: true }, { dev: true, staging: true, prod: true }),
        row("EMPTY", { dev: true, staging: true, prod: true }, { dev: false, staging: false, prod: false }, "empty-value"),
        row("WHITESPACE", { dev: true, staging: true, prod: true }, { dev: true, staging: true, prod: false }, "empty-value"),
        row("ABSENT", { dev: true, staging: true, prod: false }, { dev: true, staging: true }, "missing-in-prod"),
      ]),
      undefined,
      false,
    );
    const byKey = Object.fromEntries(lines.slice(2).map((l) => [cells(l)[0]!, cells(l).slice(1)]));
    expect(byKey.SET).toEqual(["✓", "✓", "✓"]);
    expect(byKey.EMPTY).toEqual(["∅", "∅", "∅", "defined", "but", "empty"]);
    expect(byKey.WHITESPACE).toEqual(["✓", "✓", "∅", "defined", "but", "empty"]);
    expect(byKey.ABSENT).toEqual(["✓", "✓", "·", "missing", "in", "production"]);
  });

  it("never passes an empty value off as a tick, and says nothing about the value itself", () => {
    const lines = envGroupLines(
      group([row("TURNSTILE_SECRET", { dev: true, staging: true, prod: true }, { dev: false, staging: false, prod: false }, "empty-value")], {
        emptyValue: 1,
      }),
      undefined,
      true,
    );
    const table = lines.join("\n");
    expect(table).not.toContain("✓");
    expect(table).toContain("1 defined but empty");
    expect(table).not.toContain("in step across environments");
  });

  it("leaves a stage Coolify said nothing about alone rather than calling it empty", () => {
    const lines = envGroupLines(group([row("API_KEY", { dev: true, prod: true }, { dev: true, prod: false }, "empty-value")]), undefined, false);
    expect(cells(lines[2]!)).toEqual(["API_KEY", "✓", "-", "∅", "defined", "but", "empty"]);
  });

  it("reads as settled only when every count is zero", () => {
    const all = row("SET", { dev: true, staging: true, prod: true }, { dev: true, staging: true, prod: true });
    expect(envGroupLines(group([all]), undefined, true).at(-1)).toContain("in step across environments");
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
