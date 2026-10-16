import { describe, expect, it } from "vitest";
import { columns, relativeTime } from "../src/ui.ts";

describe("relativeTime", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  it("formats recent times compactly", () => {
    expect(relativeTime("2026-09-28T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-28T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-09-28T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-25T12:00:00Z", now)).toBe("3d ago");
    expect(relativeTime("2026-01-02T12:00:00Z", now)).toBe("2026-01-02");
    expect(relativeTime(null, now)).toBe("");
  });
});

describe("columns", () => {
  it("pads on visible text, not on styled text", () => {
    expect(columns([["a", ["b", "\x1b[2mb\x1b[22m"], "c"], ["long", "bb", "c"]], "")).toEqual([
      "a     \x1b[2mb\x1b[22m   c",
      "long  bb  c",
    ]);
  });
});
