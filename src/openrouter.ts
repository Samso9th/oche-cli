/**
 * Commit messages straight from OpenRouter, for `oche pr`. Same prompt as the
 * server's (server/src/lib/ai.ts): keep the two in sync.
 */
import type { CommitMessageRequest } from "./api-types.ts";
import { CliError } from "./errors.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const SYSTEM_PROMPT = `You write git commit messages.
Use Conventional Commits: type(optional scope): subject.
The subject is imperative, lower case after the colon, at most 72 characters, no trailing period.
If the change isn't trivial, add a blank line and a short body (wrapped at 72) that says why, not how.
Match the style of the recent commit subjects you're given.
Reply with the message only: no code fences, no quotes, no emoji, no preamble.`;

export function buildMessages(input: CommitMessageRequest) {
  const parts = [
    input.branch ? `Branch: ${input.branch}` : null,
    input.recent?.length ? `Recent commit subjects:\n${input.recent.map((s) => `- ${s}`).join("\n")}` : null,
    `Files changed:\n${input.stat.trim()}`,
    `Diff:\n${input.diff}`,
  ].filter(Boolean);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** Pulls the message out of an OpenAI-style response and strips anything the model shouldn't have added. */
export function parseMessage(data: unknown): string {
  const content = (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new CliError("The model returned an empty message. Try again, or pass -m.");
  return content
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
}

export async function generateCommitMessage(
  input: CommitMessageRequest,
  opts: { apiKey: string; model: string; fetchImpl?: typeof fetch },
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", "x-title": "Oche" },
      body: JSON.stringify({ model: opts.model, messages: buildMessages(input), max_tokens: 400, temperature: 0.2 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new CliError(`Couldn't reach OpenRouter (${(e as Error).message}). Pass -m to skip AI.`);
  }
  if (res.status === 401 || res.status === 403) throw new CliError("OpenRouter rejected your API key. Run `oche ai-key` to replace it.");
  if (res.status === 402) throw new CliError("OpenRouter is out of credits. Pass -m to skip AI.");
  if (res.status === 429) throw new CliError("OpenRouter rate limit hit. Try again shortly, or pass -m.");
  if (res.status === 400 || res.status === 404) {
    const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
    throw new CliError(`OpenRouter refused the request for model ${opts.model}${detail ? `: ${detail}` : ""}.`);
  }
  if (!res.ok) throw new CliError(`OpenRouter failed (HTTP ${res.status}).`);
  return parseMessage(await res.json());
}
