import type { Branches, Promotion } from "./api-types.ts";
import { CliError } from "./errors.ts";

const DEFAULT_BRANCHES: Branches = { prod: "main", staging: "staging", dev: "dev" };

/** `oche promote <staging|prod> [--direct]` → the Promotion the server expects. */
export function toPromotion(target: string, direct = false): Promotion {
  switch (target.trim().toLowerCase()) {
    case "staging":
      if (direct) throw new CliError("--direct only applies to prod (dev → main, skipping staging).");
      return "staging";
    case "prod":
      return direct ? "prod-direct" : "prod";
    default:
      throw new CliError(`Unknown target "${target}". Use staging or prod.`);
  }
}

/** Anything that lands on the production branch gets a confirmation prompt. */
export const needsConfirmation = (p: Promotion) => p !== "staging";

export function promotionRefs(p: Promotion, branches: Branches | null = null): { head: string; base: string } {
  const b = branches ?? DEFAULT_BRANCHES;
  switch (p) {
    case "staging":
      return { head: b.dev, base: b.staging };
    case "prod":
      return { head: b.staging, base: b.prod };
    case "prod-direct":
      return { head: b.dev, base: b.prod };
  }
}
