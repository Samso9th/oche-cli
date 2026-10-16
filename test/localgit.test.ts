import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changes, currentBranch, previewAddAll, stagedDiff } from "../src/localgit.ts";

let dir: string;
let prev: string;
const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

beforeEach(() => {
  prev = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "oche-git-"));
  g("init", "-q", "-b", "feature/x");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "init");
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(prev);
  rmSync(dir, { recursive: true, force: true });
});

describe("local git", () => {
  it("reads the branch and lists modified and untracked files", async () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    expect(await currentBranch()).toBe("feature/x");
    expect(await changes()).toEqual([
      { code: " M", path: "a.txt" },
      { code: "??", path: "b.txt" },
    ]);
  });

  it("previews what git add -A would commit without touching the real index", async () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    const preview = await previewAddAll();
    expect(preview.diff).toContain("+two");
    expect(preview.diff).toContain("+new");
    expect(preview.stat).toContain("b.txt");
    // Nothing got staged for real.
    expect((await stagedDiff()).diff).toBe("");
    expect(g("status", "--porcelain")).toContain("?? b.txt");
  });
});
