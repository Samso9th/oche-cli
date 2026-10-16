import { describe, expect, it } from "vitest";
import { needsConfirmation, promotionRefs, toPromotion } from "../src/promotion.ts";

describe("toPromotion", () => {
  it("maps targets and --direct to a Promotion", () => {
    expect(toPromotion("staging")).toBe("staging");
    expect(toPromotion("prod")).toBe("prod");
    expect(toPromotion("prod", true)).toBe("prod-direct");
    expect(toPromotion("PROD", false)).toBe("prod");
  });

  it("rejects --direct with staging and unknown targets", () => {
    expect(() => toPromotion("staging", true)).toThrow(/--direct only applies to prod/);
    expect(() => toPromotion("main")).toThrow('Unknown target "main". Use staging or prod.');
  });

  it("asks for confirmation only when production moves", () => {
    expect(needsConfirmation("staging")).toBe(false);
    expect(needsConfirmation("prod")).toBe(true);
    expect(needsConfirmation("prod-direct")).toBe(true);
  });
});

describe("promotionRefs", () => {
  it("uses the repo's branch names, falling back to the conventional ones", () => {
    const branches = { prod: "master", staging: "stage", dev: "develop" };
    expect(promotionRefs("staging", branches)).toEqual({ head: "develop", base: "stage" });
    expect(promotionRefs("prod", branches)).toEqual({ head: "stage", base: "master" });
    expect(promotionRefs("prod-direct", branches)).toEqual({ head: "develop", base: "master" });
    expect(promotionRefs("prod-direct")).toEqual({ head: "dev", base: "main" });
  });
});
