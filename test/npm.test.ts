import { describe, expect, it } from "vitest";
import { parseTrustList } from "../src/npm.ts";

describe("parseTrustList", () => {
  it("reads the back-to-back objects npm prints", () => {
    const out = `{
  "id": "a",
  "type": "github",
  "file": "publish.yml",
  "repository": "me/pkg",
  "permissions": ["createPackage"]
}

{
  "id": "b",
  "type": "github",
  "file": "oche-publish.yml",
  "repository": "me/pkg"
}`;
    expect(parseTrustList(out).map((t) => [t.id, t.file])).toEqual([
      ["a", "publish.yml"],
      ["b", "oche-publish.yml"],
    ]);
  });

  it("handles braces inside strings, arrays, and nothing", () => {
    expect(parseTrustList(`{"id":"x","file":"a{b}.yml"}`)[0]?.file).toBe("a{b}.yml");
    expect(parseTrustList(`[{"id":"y"}]`).map((t) => t.id)).toEqual(["y"]);
    expect(parseTrustList("")).toEqual([]);
  });
});
