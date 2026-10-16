import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, deleteConfig, loadConfig, normalizeUrl, resolveConfig, saveConfig } from "../src/config.ts";

const saved = { url: "https://oche.example.com", token: "file-token" };

describe("resolveConfig", () => {
  it("uses the config file when no env is set", () => {
    expect(resolveConfig(saved, {})).toEqual({
      url: "https://oche.example.com",
      token: "file-token",
      urlSource: "config",
      tokenSource: "config",
    });
  });

  it("lets OCHE_URL and OCHE_TOKEN override the file", () => {
    const r = resolveConfig(saved, { OCHE_URL: "https://other.example.com/", OCHE_TOKEN: "env-token" });
    expect(r).toEqual({ url: "https://other.example.com", token: "env-token", urlSource: "env", tokenSource: "env" });
  });

  it("overrides the token alone and keeps the saved URL", () => {
    const r = resolveConfig(saved, { OCHE_TOKEN: "env-token" });
    expect(r.url).toBe("https://oche.example.com");
    expect(r.urlSource).toBe("config");
    expect(r.token).toBe("env-token");
    expect(r.tokenSource).toBe("env");
  });

  it("never sends the saved token to a different OCHE_URL", () => {
    const r = resolveConfig(saved, { OCHE_URL: "https://elsewhere.example.com" });
    expect(r.url).toBe("https://elsewhere.example.com");
    expect(r.token).toBeNull();
    expect(r.tokenSource).toBe("none");
  });

  it("still uses the saved token when OCHE_URL names the same server", () => {
    expect(resolveConfig(saved, { OCHE_URL: "oche.example.com/" }).token).toBe("file-token");
  });

  it("ignores blank env vars and reports nothing when neither is set", () => {
    expect(resolveConfig(null, { OCHE_URL: " ", OCHE_TOKEN: "" })).toEqual({
      url: null,
      token: null,
      urlSource: "none",
      tokenSource: "none",
    });
  });
});

describe("normalizeUrl", () => {
  it("adds a scheme and strips trailing slashes", () => {
    expect(normalizeUrl("oche.example.com/")).toBe("https://oche.example.com");
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("https://example.com/oche//")).toBe("https://example.com/oche");
  });

  it("rejects non-http URLs", () => {
    expect(() => normalizeUrl("ftp://example.com")).toThrow(/http/);
    expect(() => normalizeUrl("")).toThrow(/empty/);
  });
});

describe("config file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oche-cli-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lives under XDG_CONFIG_HOME when set", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "oche", "config.json"));
  });

  it("saves with 0600 permissions and reads back", async () => {
    const path = join(dir, "oche", "config.json");
    await saveConfig({ ...saved, login: "sam" }, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...saved, login: "sam" });
    expect(await loadConfig(path)).toEqual({ ...saved, login: "sam" });
    expect(await deleteConfig(path)).toBe(true);
    expect(await loadConfig(path)).toBeNull();
    expect(await deleteConfig(path)).toBe(false);
  });
});
