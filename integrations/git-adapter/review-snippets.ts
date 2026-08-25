import { redact } from "./core.js";

export interface SnippetCandidate {
  readonly key: string;
  readonly file: string;
  readonly line: number;
}

export interface ReviewSnippet {
  readonly key: string;
  /** Percent-encoded display path safe for an inline Slack code reference. */
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly language?: "hcl" | "yaml" | "json";
  /** Slack-safe code text. Rendering must use `rendered`, not rebuild a fence. */
  readonly code: string;
  /** Complete action-adjacent Slack transport; copy exactly without decoding. */
  readonly rendered: string;
}

/** A redacted, bounded file window read from the immutable PR head. */
export interface PullRequestFileContext {
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
  readonly secretsRedacted: true;
}

interface HunkLine {
  readonly line: number;
  readonly code: string;
}

interface DiffHunk {
  readonly file: string;
  readonly lines: readonly HunkLine[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_FILE_HEADER = /^\+\+\+ ([^\t\n]+)(?:\t.*)?$/;
const MAX_SNIPPETS = 2;
const MAX_LINES = 8;
const MAX_RENDERED_CODE_CHARS = 4_096;
const SECRET_CONTEXT = /(?:password|passwd|pwd|secret|token|auth|credential|webhook|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const PRIVATE_KEY_MARKER = /-----\s*(?:BEGIN|END)?[^\n-]*PRIVATE KEY(?:-----)?/i;
const REDACTION_MARKER = /\[REDACTED_[A-Z_]+\]/;

function languageFor(file: string): ReviewSnippet["language"] {
  const lower = file.toLowerCase();
  if (lower.endsWith(".tf") || lower.endsWith(".tfvars")) return "hcl";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  return undefined;
}

function displayFileFor(file: string): string {
  let display = "";
  for (const character of file) {
    if (/^[A-Za-z0-9._/-]$/.test(character)) {
      display += character;
      continue;
    }
    display += [...Buffer.from(character, "utf8")]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join("");
  }
  return display;
}

function transportKeyFor(key: string): string {
  return displayFileFor(key).replaceAll("%3A", ":");
}

function slackSafeCode(code: string): string {
  let safe = "";
  for (const character of code) {
    if (character === "\n") {
      safe += character;
      continue;
    }
    const point = character.codePointAt(0) ?? 0;
    if (character === "`" || character === "<" || character === ">" || character === "&"
      || character === "@" || character === "!" || point < 0x20 || (point >= 0x7f && point <= 0x9f)) {
      safe += point <= 0xffff
        ? `\\u${point.toString(16).padStart(4, "0")}`
        : `\\u{${point.toString(16)}}`;
      continue;
    }
    safe += character;
  }
  return safe;
}

function hasUnsafeSecretContext(input: string): boolean {
  if (SECRET_CONTEXT.test(input) || PRIVATE_KEY_MARKER.test(input) || REDACTION_MARKER.test(input)) return true;
  return redact(input) !== input;
}

function sanitizedSnippetCode(excerpt: string, adjacentContext: string): string | undefined {
  if (hasUnsafeSecretContext(adjacentContext)) return undefined;
  const redacted = redact(excerpt);
  if (redacted !== excerpt || !redacted.trim() || !hasVisibleContent(redacted)) return undefined;
  const safe = slackSafeCode(redacted);
  return safe.length <= MAX_RENDERED_CODE_CHARS ? safe : undefined;
}

function parseFileHeader(rawLine: string): string | undefined {
  const match = DIFF_FILE_HEADER.exec(rawLine);
  if (!match) return undefined;
  const file = match[1]?.startsWith("b/") ? match[1].slice(2) : match[1];
  if (!file || file === "/dev/null" || file.startsWith("/") || file.includes("\0")) return undefined;
  if (file.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return file;
}

function parseHunks(diff: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let file: string | undefined;
  let lines: HunkLine[] | undefined;
  let nextLine = 0;

  const finishHunk = () => {
    if (file && lines?.length) hunks.push({ file, lines });
    lines = undefined;
  };

  for (const rawLine of diff.split("\n")) {
    if (!lines && rawLine.startsWith("+++")) {
      file = parseFileHeader(rawLine);
      continue;
    }
    const hunkHeader = HUNK_HEADER.exec(rawLine);
    if (hunkHeader) {
      finishHunk();
      if (!file) continue;
      lines = [];
      nextLine = Number(hunkHeader[1]);
      continue;
    }
    if (!lines) continue;
    if (rawLine.startsWith(" ") || rawLine.startsWith("+")) {
      lines.push({ line: nextLine, code: rawLine.slice(1) });
      nextLine += 1;
    } else if (rawLine.startsWith("-")) {
      continue;
    } else {
      finishHunk();
    }
  }
  finishHunk();
  return hunks;
}

function boundedLines(lines: readonly HunkLine[], index: number): readonly HunkLine[] {
  const start = Math.max(0, Math.min(index - Math.floor(MAX_LINES / 2), lines.length - MAX_LINES));
  return lines.slice(start, start + MAX_LINES);
}

function renderSnippet(candidate: SnippetCandidate, lines: readonly HunkLine[], candidateIndex: number): ReviewSnippet | undefined {
  const excerpt = boundedLines(lines, candidateIndex);
  const excerptStart = lines.indexOf(excerpt[0] as HunkLine);
  const excerptEnd = excerptStart + excerpt.length;
  const adjacentContext = lines
    .slice(Math.max(0, excerptStart - 5), Math.min(lines.length, excerptEnd + 5))
    .map((line) => line.code)
    .join("\n");
  const code = sanitizedSnippetCode(excerpt.map((line) => line.code).join("\n"), adjacentContext);
  if (!code) return undefined;
  const language = languageFor(candidate.file);
  const file = displayFileFor(candidate.file);
  return {
    key: transportKeyFor(candidate.key),
    file,
    startLine: excerpt[0]?.line ?? candidate.line,
    endLine: excerpt.at(-1)?.line ?? candidate.line,
    ...(language ? { language } : {}),
    code,
    rendered: [
      `\`${file}:${candidate.line}\``,
      `\`\`\`${language ?? ""}`,
      code,
      "```",
    ].join("\n"),
  };
}

function hasVisibleContent(code: string): boolean {
  return code.replace(/\[REDACTED_[A-Z_]+\]/g, "").trim().length > 0;
}

export function selectReviewSnippets(
  redactedDiff: string,
  candidates: readonly SnippetCandidate[],
): readonly ReviewSnippet[] {
  const hunks = parseHunks(redactedDiff);
  const snippets: ReviewSnippet[] = [];

  for (const candidate of candidates) {
    if (snippets.length === MAX_SNIPPETS) break;
    if (!Number.isSafeInteger(candidate.line) || candidate.line < 1) continue;
    const hunk = hunks.find((item) => item.file === candidate.file && item.lines.some((line) => line.line === candidate.line));
    if (!hunk) continue;
    const candidateIndex = hunk.lines.findIndex((line) => line.line === candidate.line);
    const snippet = renderSnippet(candidate, hunk.lines, candidateIndex);
    if (snippet) snippets.push(snippet);
  }
  return snippets;
}

/** Reuses the diff selector's redaction and Slack transport for a PR-head file window. */
export function selectContextReviewSnippet(
  candidate: SnippetCandidate,
  context: PullRequestFileContext,
): ReviewSnippet | undefined {
  if (context.file !== candidate.file || !Number.isSafeInteger(context.startLine) || context.startLine < 1) return undefined;
  const lines = context.lines.map((code, index) => ({ line: context.startLine + index, code }));
  const candidateIndex = lines.findIndex((line) => line.line === candidate.line);
  return candidateIndex < 0 ? undefined : renderSnippet(candidate, lines, candidateIndex);
}
