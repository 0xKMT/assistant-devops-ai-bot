import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DEFAULT_DIRECTORY = "/tmp/friday-error-diagnostics";
const FILE_NAME = "errors.ndjson";
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_RESPONSE_EXCERPT_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_RECORDS = 100;
const TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const OPERATIONS = new Set(["docs_fetch", "model_call"]);

export interface LocalErrorRecordInput {
  readonly operation: "docs_fetch" | "model_call";
  readonly errorMessage: string;
  readonly errorStack?: string;
  readonly httpStatus?: number;
  readonly responseExcerpt?: string;
}

export interface LocalErrorLogOptions {
  readonly directory?: string;
  readonly now?: () => number;
}

interface LocalErrorRecord extends LocalErrorRecordInput {
  readonly occurredAt: string;
}

let queuedOperation: Promise<void> = Promise.resolve();

function withQueue<T>(operation: () => Promise<T>): Promise<T> {
  const current = queuedOperation.then(operation);
  queuedOperation = current.then(() => undefined, () => undefined);
  return current;
}

function errorFile(directory = DEFAULT_DIRECTORY): string {
  return path.join(directory, FILE_NAME);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…[truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return `${result}${marker}`;
}

function redactCredentials(value: string): string {
  return value
    .replace(/(\bauthorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"']+/giu, "$1[REDACTED]")
    .replace(/(\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD)\s*[=:]\s*["']?)[^\s,;"']+/giu, "$1[REDACTED]")
    .replace(/(\bcookie\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|access_token|password|secret)=)[^&#\s]+/giu, "$1[REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    // Token shapes below use bounded quantifiers and no nested repetition so
    // hostile excerpts cannot trigger catastrophic backtracking. Minimums are
    // low because an excerpt cut at its byte cap can end mid-token.
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{1,250}/gu, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{1,255}/gu, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{1,255}/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{7,4093}\.[A-Za-z0-9_-]{0,8192}(?:\.[A-Za-z0-9_-]{0,4096})?/gu, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{1,16}\b/gu, "[REDACTED]");
}

function sanitizeText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return truncateUtf8(redactCredentials(value), maxBytes);
}

function validHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
}

function makeRecord(input: LocalErrorRecordInput, now: number): LocalErrorRecord {
  if (!OPERATIONS.has(input.operation)) throw new TypeError("Unsupported local diagnostics operation.");
  const record: LocalErrorRecord = {
    occurredAt: new Date(now).toISOString(),
    operation: input.operation,
    errorMessage: sanitizeText(input.errorMessage, 4096) ?? "Operation failed.",
    ...(input.errorStack !== undefined ? { errorStack: sanitizeText(input.errorStack, 4096) ?? "" } : {}),
    ...(validHttpStatus(input.httpStatus) ? { httpStatus: input.httpStatus } : {}),
    ...(input.responseExcerpt !== undefined
      ? { responseExcerpt: sanitizeText(input.responseExcerpt, MAX_RESPONSE_EXCERPT_BYTES) ?? "" }
      : {}),
  };
  return record;
}

function serializeRecord(record: LocalErrorRecord): string {
  const bounded: Record<string, unknown> = { ...record };
  let serialized = JSON.stringify(bounded);
  while (Buffer.byteLength(serialized, "utf8") + 1 > MAX_RECORD_BYTES) {
    const key = ["responseExcerpt", "errorStack", "errorMessage"].find((field) => typeof bounded[field] === "string");
    if (!key) throw new RangeError("Local diagnostics metadata exceeded its record limit.");
    const current = bounded[key] as string;
    const currentBytes = Buffer.byteLength(current, "utf8");
    const targetBytes = Math.max(0, Math.floor(currentBytes * 0.75));
    bounded[key] = truncateUtf8(current, targetBytes);
    serialized = JSON.stringify(bounded);
  }
  return serialized;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Local diagnostics path is not a private directory.");
  await chmod(directory, 0o700);
}

async function readExistingRecords(directory: string): Promise<LocalErrorRecord[]> {
  const file = errorFile(directory);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Local diagnostics file is not a regular file.");
    await chmod(file, 0o600);
    const content = await readFile(file, "utf8");
    const records: LocalErrorRecord[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Partial<LocalErrorRecordInput> & { occurredAt?: unknown };
        const occurredAt = typeof parsed.occurredAt === "string" ? Date.parse(parsed.occurredAt) : Number.NaN;
        if (!Number.isFinite(occurredAt) || typeof parsed.operation !== "string" || !OPERATIONS.has(parsed.operation)) continue;
        records.push(makeRecord(parsed as LocalErrorRecordInput, occurredAt));
      } catch {
        // Discard malformed or unsupported historical records without echoing them.
      }
    }
    return records;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function retainRecentRecords(records: readonly LocalErrorRecord[], now: number): LocalErrorRecord[] {
  return records.filter((record) => {
    const occurredAt = Date.parse(record.occurredAt);
    return Number.isFinite(occurredAt) && occurredAt <= now && now - occurredAt <= TTL_MS;
  });
}

async function writeRecords(directory: string, records: readonly LocalErrorRecord[]): Promise<void> {
  const file = errorFile(directory);
  if (records.length === 0) {
    await unlink(file).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    return;
  }
  let lines = records.map(serializeRecord);
  while (lines.length > MAX_RECORDS || Buffer.byteLength(`${lines.join("\n")}\n`, "utf8") > MAX_TOTAL_BYTES) {
    lines.shift();
  }
  const contents = `${lines.join("\n")}\n`;
  const temporary = path.join(directory, `.${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
}

function clock(options?: LocalErrorLogOptions): number {
  const value = options?.now?.() ?? Date.now();
  if (!Number.isFinite(value)) throw new TypeError("Local diagnostics clock must return a finite timestamp.");
  return value;
}

export async function appendLocalErrorRecord(
  input: LocalErrorRecordInput,
  options?: LocalErrorLogOptions,
): Promise<void> {
  await withQueue(async () => {
    const directory = options?.directory ?? DEFAULT_DIRECTORY;
    const now = clock(options);
    await ensurePrivateDirectory(directory);
    const existing = retainRecentRecords(await readExistingRecords(directory), now);
    const record = makeRecord(input, now);
    const serialized = serializeRecord(record);
    existing.push(JSON.parse(serialized) as LocalErrorRecord);
    await writeRecords(directory, existing);
  });
}

export async function pruneLocalErrorRecords(options?: LocalErrorLogOptions): Promise<void> {
  await withQueue(async () => {
    const directory = options?.directory ?? DEFAULT_DIRECTORY;
    const now = clock(options);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Local diagnostics path is not a private directory.");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await chmod(directory, 0o700);
    const previous = await readExistingRecords(directory);
    const recent = retainRecentRecords(previous, now);
    if (recent.length !== previous.length) await writeRecords(directory, recent);
  });
}

export async function clearLocalErrorRecords(options?: Pick<LocalErrorLogOptions, "directory">): Promise<void> {
  await withQueue(async () => {
    const directory = options?.directory ?? DEFAULT_DIRECTORY;
    await unlink(errorFile(directory)).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  });
}

export function startLocalErrorLogPruner(): () => void {
  void pruneLocalErrorRecords().catch(() => undefined);
  const timer = setInterval(() => { void pruneLocalErrorRecords().catch(() => undefined); }, PRUNE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
