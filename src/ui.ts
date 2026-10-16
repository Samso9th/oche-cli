import { createInterface, type Interface } from "node:readline";
import { styleText } from "node:util";
import { CliError } from "./errors.ts";

type Format = Parameters<typeof styleText>[0];
type Stream = NodeJS.WriteStream;

/** Color only on a TTY, and never when NO_COLOR is set. styleText checks FORCE_COLOR and friends too. */
export function paint(format: Format, text: string, stream: Stream = process.stdout): string {
  if (process.env.NO_COLOR) return text;
  return styleText(format, text, { stream, validateStream: true });
}

export const c = {
  bold: (s: string) => paint("bold", s),
  dim: (s: string) => paint("dim", s),
  green: (s: string) => paint("green", s),
  red: (s: string) => paint("red", s),
  yellow: (s: string) => paint("yellow", s),
  cyan: (s: string) => paint("cyan", s),
};

export const print = (line = ""): void => void process.stdout.write(`${line}\n`);
export const printJson = (data: unknown): void => print(JSON.stringify(data, null, 2));
export const ok = (msg: string) => print(`${c.green("✓")} ${msg}`);
export const warn = (msg: string) => process.stderr.write(`${paint("yellow", "!", process.stderr)} ${msg}\n`);
export const fail = (msg: string) => process.stderr.write(`${paint("red", "✗", process.stderr)} ${msg}\n`);

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Lays out rows as aligned columns. Cells are [plain, styled?] so padding is
 * computed on the visible text; the last column is never padded.
 */
export type Cell = string | [plain: string, styled: string];

export function columns(rows: Cell[][], indent = "  "): string[] {
  const plainOf = (cell: Cell) => (typeof cell === "string" ? cell : cell[0]);
  const styledOf = (cell: Cell) => (typeof cell === "string" ? cell : cell[1]);
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, plainOf(cell).length)));
  return rows.map(
    (row) =>
      indent +
      row
        .map((cell, i) => (i === row.length - 1 ? styledOf(cell) : styledOf(cell) + " ".repeat((widths[i] ?? 0) - plainOf(cell).length)))
        .join("  ")
        .trimEnd(),
  );
}

/* ------------------------------------------------------------------ */
/* Prompts (on stderr, so stdout stays pipeable)                       */
/* ------------------------------------------------------------------ */

export const isInteractive = () => Boolean(process.stdin.isTTY);

let reader: { rl: Interface; lines: AsyncIterator<string> } | null = null;

async function readLine(): Promise<string> {
  if (!reader) {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    reader = { rl, lines: rl[Symbol.asyncIterator]() };
  }
  const next = await reader.lines.next();
  if (next.done) throw new CliError("No input: stdin was closed.");
  return next.value;
}

export function closeReader() {
  reader?.rl.close();
  reader = null;
}

export async function ask(question: string, fallback?: string): Promise<string> {
  process.stderr.write(fallback ? `${question} ${paint("dim", `(${fallback})`, process.stderr)}: ` : `${question}: `);
  const answer = (await readLine()).trim();
  if (isInteractive()) closeReader();
  else process.stderr.write("\n");
  return answer || fallback || "";
}

export async function askHidden(question: string): Promise<string> {
  process.stderr.write(`${question}: `);
  if (!isInteractive()) {
    const line = (await readLine()).trim();
    process.stderr.write("\n");
    return line;
  }
  closeReader();
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = (err?: CliError) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(buf.trim());
    };
    const onData = (chunk: Buffer | string) => {
      // Drop bracketed-paste markers and arrow-key style escape sequences.
      const text = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new CliError("Cancelled.", 130));
        if (ch === "\u0004") return buf ? finish() : finish(new CliError("Cancelled.", 130));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch === "\u0015") buf = "";
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** y/n prompt. Refuses to guess when there is no terminal: pass --yes instead. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!isInteractive()) throw new CliError(`${question} Needs confirmation; pass --yes to run without a prompt.`);
  const hint = defaultYes ? "Y/n" : "y/N";
  process.stderr.write(`${question} ${paint("dim", `[${hint}]`, process.stderr)} `);
  const answer = (await readLine()).trim().toLowerCase();
  closeReader();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}
