import { wrapUntrustedContent } from "@friday/shared";
import { appendLocalErrorRecord, type LocalErrorRecordInput } from "./local-error-log.js";

const OPENAI_LATEST_MODEL_GUIDE_URL = "https://developers.openai.com/api/docs/guides/latest-model.md";
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 131_072;
const REQUEST_TIMEOUT_MS = 5_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type OpenAIDocsFailureCategory =
  | "timeout"
  | "network"
  | "authorization"
  | "not_found"
  | "rate_limit"
  | "http_4xx"
  | "http_5xx"
  | "redirect_rejected"
  | "invalid_content"
  | "response_too_large";

export type OpenAIDocsResult =
  | {
      readonly ok: true;
      readonly sourceUrl: string;
      readonly retrievedAt: string;
      readonly markdown: string;
    }
  | {
      readonly ok: false;
      readonly category: OpenAIDocsFailureCategory;
      readonly httpStatus?: number;
    };

export type OpenAIDocsToolPayload =
  | {
      readonly ok: true;
      readonly sourceUrl: string;
      readonly retrievedAt: string;
      readonly content: string;
    }
  | {
      readonly ok: false;
      readonly category: OpenAIDocsFailureCategory;
      readonly httpStatus?: number;
      readonly errorCode: string;
    };

type BoundedBodyResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly category: "invalid_content" | "response_too_large" };

type OpenAIDocsFailure = Extract<OpenAIDocsResult, { readonly ok: false }>;
type FailureAppender = (record: LocalErrorRecordInput) => Promise<void>;

/** Gates the initial URL and every redirect hop; exported for tests only. */
export function isAllowedDocsUrl(url: URL): boolean {
  return url.protocol === "https:"
    && url.hostname === "developers.openai.com"
    && url.port === ""
    && url.username === ""
    && url.password === ""
    && url.pathname.startsWith("/api/docs/");
}

function httpFailure(status: number): OpenAIDocsResult {
  const category: OpenAIDocsFailureCategory = status === 401 || status === 403
    ? "authorization"
    : status === 404
      ? "not_found"
      : status === 429
        ? "rate_limit"
        : status >= 400 && status <= 499
          ? "http_4xx"
          : "http_5xx";
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? { ok: false, category, httpStatus: status }
    : { ok: false, category };
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!error || (typeof error !== "object" && typeof error !== "function")) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "name");
    const name = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (name === "TimeoutError" || name === "AbortError") return true;
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
      const nativeName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name");
      if (nativeName?.get) {
        const nativeValue = nativeName.get.call(error);
        return nativeValue === "TimeoutError" || nativeValue === "AbortError";
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  await body.cancel().catch(() => undefined);
}

async function readErrorResponseExcerpt(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < 8_192) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = 8_192 - totalBytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function localErrorDetails(error: unknown): Pick<LocalErrorRecordInput, "errorMessage" | "errorStack"> {
  if (error instanceof Error) {
    const message = Object.getOwnPropertyDescriptor(error, "message");
    const stack = Object.getOwnPropertyDescriptor(error, "stack");
    return {
      errorMessage: message && "value" in message && typeof message.value === "string" && message.value
        ? message.value
        : "OpenAI documentation fetch failed.",
      ...(stack && "value" in stack && typeof stack.value === "string" ? { errorStack: stack.value } : {}),
    };
  }
  return { errorMessage: typeof error === "string" ? error : "OpenAI documentation fetch failed." };
}

async function readBoundedMarkdown(response: Response): Promise<BoundedBodyResult> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/markdown" && contentType !== "text/plain") {
    await cancelBody(response.body);
    return { ok: false, category: "invalid_content" };
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await cancelBody(response.body);
    return { ok: false, category: "response_too_large" };
  }

  if (!response.body) return { ok: true, text: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, category: "response_too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, category: "invalid_content" };
  }
}

/** Reads only the fixed official OpenAI guide; failure details are local-only and best-effort. */
export async function fetchLatestOpenAIModelGuide(
  fetchImpl: typeof fetch = fetch,
  appendFailure: FailureAppender = appendLocalErrorRecord,
): Promise<OpenAIDocsResult> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let currentUrl = new URL(OPENAI_LATEST_MODEL_GUIDE_URL);

  const fail = async (
    result: OpenAIDocsFailure,
    details: Omit<LocalErrorRecordInput, "operation">,
  ): Promise<OpenAIDocsFailure> => {
    try {
      await appendFailure({ operation: "docs_fetch", ...details });
    } catch {
      // A local diagnostics failure must not alter the model-facing result.
    }
    return result;
  };

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      if (!isAllowedDocsUrl(currentUrl)) {
        return await fail({ ok: false, category: "redirect_rejected" }, {
          errorMessage: "OpenAI documentation redirect was rejected.",
        });
      }

      let response: Response;
      try {
        response = await fetchImpl(currentUrl, {
          method: "GET",
          headers: { accept: "text/markdown, text/plain" },
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
          signal: timeoutSignal,
        });
      } catch (error) {
        const localDetails = localErrorDetails(error);
        return await fail({
          ok: false,
          category: isTimeoutError(error, timeoutSignal) ? "timeout" : "network",
        }, localDetails);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) {
          await cancelBody(response.body);
          return await fail({ ok: false, category: "redirect_rejected" }, {
            errorMessage: "OpenAI documentation redirect was rejected.",
          });
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          await cancelBody(response.body);
          return await fail({ ok: false, category: "redirect_rejected" }, {
            errorMessage: "OpenAI documentation redirect was rejected.",
          });
        }
        await cancelBody(response.body);
        if (!isAllowedDocsUrl(nextUrl)) {
          return await fail({ ok: false, category: "redirect_rejected" }, {
            errorMessage: "OpenAI documentation redirect was rejected.",
          });
        }
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        const responseExcerpt = response.status >= 400 && response.status <= 599
          ? await readErrorResponseExcerpt(response)
          : undefined;
        await cancelBody(response.body);
        if (response.status >= 400 && response.status <= 599) {
          return await fail(httpFailure(response.status) as OpenAIDocsFailure, {
            errorMessage: `OpenAI documentation endpoint returned HTTP ${response.status}.`,
            httpStatus: response.status,
            ...(responseExcerpt === undefined ? {} : { responseExcerpt }),
          });
        }
        return await fail({ ok: false, category: "invalid_content" }, {
          errorMessage: "OpenAI documentation endpoint returned an invalid HTTP response.",
        });
      }

      const body = await readBoundedMarkdown(response);
      if (!body.ok) {
        return await fail(body, {
          errorMessage: body.category === "response_too_large"
            ? "OpenAI documentation response exceeded the size limit."
            : "OpenAI documentation response was not valid Markdown or plain text.",
        });
      }

      return {
        ok: true,
        sourceUrl: currentUrl.href,
        retrievedAt: new Date().toISOString(),
        markdown: body.text,
      };
    }
  } catch (error) {
    const localDetails = localErrorDetails(error);
    return await fail({
      ok: false,
      category: isTimeoutError(error, timeoutSignal) ? "timeout" : "network",
    }, localDetails);
  }

  return await fail({ ok: false, category: "redirect_rejected" }, {
    errorMessage: "OpenAI documentation redirect was rejected.",
  });
}

export function openAIDocsErrorCode(category: OpenAIDocsFailureCategory): string {
  const codes: Readonly<Record<OpenAIDocsFailureCategory, string>> = {
    timeout: "DOCS_TIMEOUT",
    network: "DOCS_NETWORK",
    authorization: "DOCS_AUTHORIZATION",
    not_found: "DOCS_NOT_FOUND",
    rate_limit: "DOCS_RATE_LIMITED",
    http_4xx: "DOCS_HTTP_4XX",
    http_5xx: "DOCS_HTTP_5XX",
    redirect_rejected: "DOCS_REDIRECT_REJECTED",
    invalid_content: "DOCS_INVALID_CONTENT",
    response_too_large: "DOCS_RESPONSE_TOO_LARGE",
  };
  return codes[category];
}

/**
 * Builds the model-facing tool payload. Document text is only ever returned
 * inside untrusted-data markers, sized to the body cap so nothing is cut.
 */
export function buildOpenAIDocsToolPayload(result: OpenAIDocsResult): OpenAIDocsToolPayload {
  if (!result.ok) return { ...result, errorCode: openAIDocsErrorCode(result.category) };
  return {
    ok: true,
    sourceUrl: result.sourceUrl,
    retrievedAt: result.retrievedAt,
    content: wrapUntrustedContent("OpenAI documentation", result.markdown, MAX_RESPONSE_BYTES),
  };
}
