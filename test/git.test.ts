import { describe, expect, it } from "vitest";
import { parseGitHubRemote, parseRepoArg } from "../src/git.ts";

const acme = { owner: "acme", repo: "web" };

describe("parseGitHubRemote", () => {
  it.each([
    "https://github.com/acme/web.git",
    "https://github.com/acme/web",
    "https://github.com/acme/web/",
    "http://github.com/acme/web.git",
    "https://sam@github.com/acme/web.git",
    "https://x-access-token:abc123@github.com/acme/web.git",
    "git@github.com:acme/web.git",
    "git@github.com:acme/web",
    "github.com:acme/web.git",
    "ssh://git@github.com/acme/web.git",
    "ssh://git@ssh.github.com:443/acme/web.git",
    "git+ssh://git@github.com/acme/web.git",
    "git://github.com/acme/web.git",
    "git@github.com-work:acme/web.git",
    "  https://github.com/acme/web.git\n",
  ])("reads %s", (url) => {
    expect(parseGitHubRemote(url)).toEqual(acme);
  });

  it("keeps dots, dashes and underscores in repo names", () => {
    expect(parseGitHubRemote("git@github.com:my-org/some_repo.js.git")).toEqual({ owner: "my-org", repo: "some_repo.js" });
  });

  it.each([
    "https://gitlab.com/acme/web.git",
    "git@bitbucket.org:acme/web.git",
    "https://github.com.evil.com/acme/web.git",
    "https://github.com/acme",
    "https://github.com/acme/web/tree/main",
    "file:///tmp/acme/web.git",
    "/local/path/web.git",
    "",
  ])("rejects %s", (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });
});

describe("parseRepoArg", () => {
  it("accepts owner/repo and GitHub URLs", () => {
    expect(parseRepoArg("acme/web")).toEqual(acme);
    expect(parseRepoArg("https://github.com/acme/web")).toEqual(acme);
  });

  it("throws a readable error otherwise", () => {
    expect(() => parseRepoArg("web")).toThrow('Expected owner/repo, got "web".');
    expect(() => parseRepoArg("acme/web/extra")).toThrow(/owner\/repo/);
  });
});
