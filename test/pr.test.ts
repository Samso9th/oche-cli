import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHub } from "../src/github.ts";
import { DEFAULT_MODEL, resolveAi } from "../src/local-config.ts";
import { fetchBranch, subjectsAhead } from "../src/localgit.ts";
import { parseMessage } from "../src/openrouter.ts";
import { PROTECTED, prBody, prTitle, titleFromBranch } from "../src/pr.ts";

describe("pr titles and bodies", () => {
  it("uses the only commit's subject, or the branch name for several", () => {
    expect(prTitle(["feat: add login"], "feature/login")).toBe("feat: add login");
    expect(prTitle(["b", "a"], "feature/login-page")).toBe("Login page");
    expect(titleFromBranch("fix_typo")).toBe("Fix typo");
  });

  it("lists commits oldest first", () => {
    expect(prBody(["second", "first"])).toMatch(/^- first\n- second\n/);
    expect(prBody([])).toBe("");
  });

  it("never ships from a long-lived branch", () => {
    for (const b of ["main", "master", "staging", "dev", "develop"]) expect(PROTECTED.has(b)).toBe(true);
    expect(PROTECTED.has("feature/x")).toBe(false);
  });
});

describe("AI settings", () => {
  it("prefers the environment over the saved file", () => {
    expect(resolveAi({ openrouterKey: "file", model: "m/file" }, { OPENROUTER_API_KEY: "env", OCHE_AI_MODEL: "m/env" })).toEqual({
      key: "env",
      model: "m/env",
    });
    expect(resolveAi({}, {})).toEqual({ key: null, model: DEFAULT_MODEL });
  });

  it("strips fences and quotes from the model's reply", () => {
    expect(parseMessage({ choices: [{ message: { content: "```\nfeat: x\n```" } }] })).toBe("feat: x");
    expect(parseMessage({ choices: [{ message: { content: '"fix: y"' } }] })).toBe("fix: y");
  });
});

describe("GitHub client", () => {
  const repo = { owner: "o", repo: "r" };
  const fake = (routes: Record<string, () => Response>) => {
    const calls: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(url).replace("https://api.github.com", "")}`;
      calls.push(key);
      const route = routes[key];
      return route ? route() : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
    return { impl, calls };
  };

  it("picks dev, falling back to develop", async () => {
    const { impl, calls } = fake({ "GET /repos/o/r/branches/develop": () => Response.json({}) });
    expect(await new GitHub("t", impl).firstBranch(repo, ["dev", "develop"])).toBe("develop");
    expect(calls).toEqual(["GET /repos/o/r/branches/dev", "GET /repos/o/r/branches/develop"]);
  });

  it("explains a refused PR", async () => {
    const { impl } = fake({
      "POST /repos/o/r/pulls": () => Response.json({ message: "Validation Failed", errors: [{ message: "No commits between dev and x" }] }, { status: 422 }),
    });
    await expect(new GitHub("t", impl).createPull(repo, { head: "x", base: "dev", title: "t", body: "" })).rejects.toThrow(
      /Validation Failed: No commits between dev and x/,
    );
  });
});

describe("commits ahead of the base", () => {
  let root: string;
  let prev: string;
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  beforeEach(() => {
    prev = process.cwd();
    root = mkdtempSync(join(tmpdir(), "oche-pr-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    g(root, "init", "-q", "--bare", "-b", "dev", remote);
    g(root, "clone", "-q", remote, work);
    g(work, "config", "user.email", "t@example.com");
    g(work, "config", "user.name", "T");
    g(work, "config", "commit.gpgsign", "false");
    g(work, "switch", "-q", "-c", "dev");
    writeFileSync(join(work, "a.txt"), "one\n");
    g(work, "add", ".");
    g(work, "commit", "-q", "-m", "init");
    g(work, "push", "-q", "origin", "dev");
    g(work, "switch", "-q", "-c", "feature/x");
    writeFileSync(join(work, "a.txt"), "two\n");
    g(work, "commit", "-q", "-am", "feat: two");
    process.chdir(work);
  });

  afterEach(() => {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  });

  it("lists only the work branch's commits", async () => {
    await fetchBranch("dev");
    expect(await subjectsAhead("dev")).toEqual(["feat: two"]);
  });
});
