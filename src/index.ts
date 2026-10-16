#!/usr/bin/env node
import { buildProgram } from "./commands.ts";
import { CliError } from "./errors.ts";
import { closeReader, fail } from "./ui.ts";

// `oche log | head` closes the pipe early; that isn't an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

try {
  await buildProgram().parseAsync(process.argv);
} catch (e) {
  if (e instanceof CliError) {
    fail(e.message);
    process.exitCode = e.exitCode;
  } else {
    fail(e instanceof Error ? e.message : String(e));
    if (process.env.OCHE_DEBUG && e instanceof Error) console.error(e.stack);
    process.exitCode = 1;
  }
} finally {
  closeReader();
}
