import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendLocalErrorRecord,
  clearLocalErrorRecords,
  pruneLocalErrorRecords,
} from "../local-error-log.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const baseTime = Date.parse("2026-09-25T00:00:00.000Z");

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "friday-local-errors-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function recordsAt(directory: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(directory, "errors.ndjson"), "utf8");
  return contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("appends one bounded local record for a failed operation", async () => {
  await withDirectory(async (directory) => {
    await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: "OpenAI docs returned HTTP 404", httpStatus: 404 }, {
      directory,
      now: () => baseTime,
    });

    const records = await recordsAt(directory);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      occurredAt: new Date(baseTime).toISOString(),
      operation: "docs_fetch",
      errorMessage: "OpenAI docs returned HTTP 404",
      httpStatus: 404,
    });
  });
});

test("redacts authorization, API key, and cookie values from every raw diagnostic field", async () => {
  await withDirectory(async (directory) => {
    await appendLocalErrorRecord({
      operation: "model_call",
      errorMessage: "Authorization: Bearer FRIDAY_SENTINEL_BEARER OPENAI_API_KEY=FRIDAY_SENTINEL_KEY",
      errorStack: "at call (Authorization: Bearer FRIDAY_SENTINEL_STACK_BEARER)",
      responseExcerpt: "Cookie: FRIDAY_SENTINEL_COOKIE",
    }, { directory, now: () => baseTime });

    const contents = await readFile(path.join(directory, "errors.ndjson"), "utf8");
    assert.doesNotMatch(contents, /FRIDAY_SENTINEL_BEARER|FRIDAY_SENTINEL_KEY|FRIDAY_SENTINEL_STACK_BEARER|FRIDAY_SENTINEL_COOKIE/);
    assert.ok((contents.match(/\[REDACTED\]/g) ?? []).length >= 4);
  });
});

test("caps a serialized record at 16 KiB", async () => {
  await withDirectory(async (directory) => {
    await appendLocalErrorRecord({
      operation: "docs_fetch",
      errorMessage: "m".repeat(40_000),
      errorStack: "s".repeat(40_000),
      responseExcerpt: "r".repeat(40_000),
    }, { directory, now: () => baseTime });

    const contents = await readFile(path.join(directory, "errors.ndjson"), "utf8");
    const line = contents.trimEnd();
    assert.ok(Buffer.byteLength(line, "utf8") <= MAX_RECORD_BYTES);
    assert.equal(JSON.parse(line).operation, "docs_fetch");
  });
});

test("prunes records older than 24 hours", async () => {
  await withDirectory(async (directory) => {
    await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: "expired" }, {
      directory,
      now: () => baseTime,
    });
    await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: "current" }, {
      directory,
      now: () => baseTime + DAY_MS + 1,
    });

    await pruneLocalErrorRecords({ directory, now: () => baseTime + DAY_MS + 1 });
    const records = await recordsAt(directory);
    assert.deepEqual(records.map((record) => record.errorMessage), ["current"]);
  });
});

test("retains at most the newest 100 records", async () => {
  await withDirectory(async (directory) => {
    for (let index = 0; index < 102; index += 1) {
      await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: `record-${index}` }, {
        directory,
        now: () => baseTime + index,
      });
    }

    const records = await recordsAt(directory);
    assert.equal(records.length, 100);
    assert.equal(records[0]?.errorMessage, "record-2");
    assert.equal(records.at(-1)?.errorMessage, "record-101");
  });
});

test("evicts oldest records to keep total storage at or below 1 MiB", async () => {
  await withDirectory(async (directory) => {
    for (let index = 0; index < 80; index += 1) {
      await appendLocalErrorRecord({
        operation: "docs_fetch",
        errorMessage: `${index}:` + "m".repeat(4096),
        errorStack: "s".repeat(4096),
        responseExcerpt: "r".repeat(8192),
      }, {
        directory,
        now: () => baseTime + index,
      });
    }

    const contents = await readFile(path.join(directory, "errors.ndjson"), "utf8");
    const records = await recordsAt(directory);
    assert.ok(Buffer.byteLength(contents, "utf8") <= MAX_TOTAL_BYTES);
    assert.ok(records.length < 80);
    assert.equal(records.at(-1)?.errorMessage?.toString().slice(0, 2), "79");
  });
});

test("uses private directory and file permissions", async () => {
  await withDirectory(async (directory) => {
    await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: "permission probe" }, {
      directory,
      now: () => baseTime,
    });

    const directoryMode = (await stat(directory)).mode & 0o777;
    const fileMode = (await stat(path.join(directory, "errors.ndjson"))).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
  });
});

test("cleanup removes the volatile error file", async () => {
  await withDirectory(async (directory) => {
    await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: "remove me" }, {
      directory,
      now: () => baseTime,
    });
    await clearLocalErrorRecords({ directory });
    await assert.rejects(readFile(path.join(directory, "errors.ndjson")), { code: "ENOENT" });
  });
});

// Synthetic credential shapes are assembled at runtime so no token-shaped
// literal exists in source; every body carries a FRIDAY sentinel.
const sentinelBody = (length: number): string => `FRIDAY0SENTINEL0${"x".repeat(Math.max(0, length - 16))}`;
const syntheticCredentials: ReadonlyArray<{ readonly name: string; readonly value: string }> = [
  { name: "Slack bot token", value: ["xox", "b-", sentinelBody(40)].join("") },
  { name: "Slack user token", value: ["xox", "p-", sentinelBody(40)].join("") },
  { name: "GitHub classic token", value: ["gh", "p_", sentinelBody(36)].join("") },
  { name: "GitHub OAuth token", value: ["gh", "o_", sentinelBody(36)].join("") },
  { name: "GitHub fine-grained token", value: ["github", "_pat_", sentinelBody(82)].join("") },
  {
    name: "JWT",
    value: [["ey", "J", sentinelBody(30)].join(""), ["ey", "J", sentinelBody(40)].join(""), sentinelBody(43)].join("."),
  },
  { name: "AWS access key ID", value: ["AK", "IA", "FRIDAY0SENTINEL0"].join("") },
  { name: "AWS temporary access key ID", value: ["AS", "IA", "FRIDAY0SENTINEL0"].join("") },
];

test("redacts Slack, GitHub, JWT and AWS access-key shapes from every raw diagnostic field", async (t) => {
  for (const { name, value } of syntheticCredentials) {
    await t.test(name, async () => {
      await withDirectory(async (directory) => {
        await appendLocalErrorRecord({
          operation: "docs_fetch",
          errorMessage: `request failed with ${value} in message`,
          errorStack: `Error\n    at call (${value})`,
          responseExcerpt: `{"token":"${value}"}`,
        }, { directory, now: () => baseTime });

        const [record] = await recordsAt(directory);
        for (const field of ["errorMessage", "errorStack", "responseExcerpt"]) {
          const text = String(record?.[field]);
          assert.match(text, /\[REDACTED\]/, `${field} was not redacted`);
          assert.doesNotMatch(text, /FRIDAY0SENTINEL0/, `${field} kept the synthetic credential`);
        }
      });
    });
  }
});

test("leaves ordinary prose that merely mentions credential prefixes unchanged", async () => {
  await withDirectory(async (directory) => {
    const prose = "See xox docs, the ghp prefix, an AKIA key format note, and the eyJ header word.";
    await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: prose }, { directory, now: () => baseTime });

    const [record] = await recordsAt(directory);
    assert.equal(record?.errorMessage, prose);
  });
});

test("credential redaction stays fast on adversarial 16 KiB input", async () => {
  await withDirectory(async (directory) => {
    const adversarial = [
      ["ey", "J"].join("") + "A".repeat(16_000),
      ["ey", "J"].join("") + "A.".repeat(8_000),
      ["xox", "b-"].join("") + "-".repeat(16_000),
      ["github", "_pat_"].join("") + "_".repeat(16_000),
      ["AK", "IA"].join("") + "A".repeat(16_000),
    ];
    for (const input of adversarial) {
      const started = performance.now();
      await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: input }, { directory, now: () => baseTime });
      assert.ok(performance.now() - started < 100, "redaction took too long");
    }
  });
});

test("redacts credential prefixes cut short at the response-excerpt boundary", async (t) => {
  const truncated: ReadonlyArray<{ readonly name: string; readonly value: string }> = [
    { name: "Slack token", value: ["xox", "b-", "FRIDAY0SENTINEL0"].join("") },
    { name: "GitHub classic token", value: ["gh", "p_", "FRIDAY0SENTINEL0"].join("") },
    { name: "GitHub fine-grained token", value: ["github", "_pat_", "FRIDAY0SENTINEL0"].join("") },
    { name: "JWT without signature", value: [["ey", "J", sentinelBody(30)].join(""), "FRIDAY0SENTINEL0"].join(".") },
    { name: "AWS access key ID", value: ["AK", "IA", "FRIDAY0SENTINE"].join("") },
  ];
  for (const { name, value } of truncated) {
    await t.test(name, async () => {
      await withDirectory(async (directory) => {
        await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage: "HTTP 500", responseExcerpt: `{"token":"${value}` }, {
          directory,
          now: () => baseTime,
        });

        const [record] = await recordsAt(directory);
        assert.match(String(record?.responseExcerpt), /\[REDACTED\]/);
        assert.doesNotMatch(String(record?.responseExcerpt), /FRIDAY0SENTINE/);
      });
    });
  }
});
