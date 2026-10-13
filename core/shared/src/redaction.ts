/**
 * One strict credential-shape set shared by every Friday redaction boundary.
 * Callers keep their own context rules and apply this set in addition, so
 * adopting it can only widen redaction.
 *
 * Every quantifier is bounded and no repetition is nested. Patterns with an
 * upper bound carry no trailing `\b`, so an overlong token still loses its
 * prefix instead of escaping entirely. The JWT pattern consumes each segment
 * atomically (`(?=(...))\1`); `.` is outside the segment class, so this
 * matches the same strings as plain backtracking without the hostile-input
 * cost.
 */
const BASE64URL = "[A-Za-z0-9_-]";

const MAX_PRIVATE_KEY_BODY = 16 * 1024;

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9_]{20,255}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g,
  /\bxapp-[A-Za-z0-9-]{10,255}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{1,512}/gi,
  // An uppercase letter and a digit are required in the body: Kubernetes and
  // Helm names are lowercase (RFC 1123), so `sk-app-worker-v2-...` survives.
  /\bsk-(?:proj-)?(?=[a-z0-9_-]{0,255}[A-Z])(?=[A-Za-z_-]{0,255}[0-9])[A-Za-z0-9_-]{20,255}/g,
  new RegExp(
    `(?<!${BASE64URL})eyJ(?=(${BASE64URL}{5,2048}))\\1\\.(?=(${BASE64URL}{8,8192}))\\2\\.${BASE64URL}{8,2048}`,
    "g",
  ),
];

const URL_USERINFO = /(https?:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi;

/**
 * Removes each PEM private-key block, pairing a BEGIN line with the nearest
 * END line at most MAX_PRIVATE_KEY_BODY characters later, like a bounded lazy
 * match. A header without such an END (output cut at a byte cap) is redacted
 * through the end of the input. The END position is reused across BEGIN lines
 * so the scan stays linear.
 */
function redactPrivateKeyBlocks(value: string, replacement: string): string {
  const begin = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
  const end = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
  let output = "";
  let cursor = 0;
  let nextEnd: RegExpExecArray | null | undefined;
  for (let header = begin.exec(value); header; header = begin.exec(value)) {
    const bodyStart = header.index + header[0].length;
    if (nextEnd === undefined || (nextEnd && nextEnd.index < bodyStart)) {
      end.lastIndex = bodyStart;
      nextEnd = end.exec(value);
    }
    output += value.slice(cursor, header.index) + replacement;
    if (!nextEnd || nextEnd.index - bodyStart > MAX_PRIVATE_KEY_BODY) return output;
    cursor = nextEnd.index + nextEnd[0].length;
    begin.lastIndex = cursor;
  }
  return output + value.slice(cursor);
}

/** Replaces credential-shaped substrings; non-credential text is unchanged. */
export function redactCredentialShapes(value: string, replacement = "[REDACTED]"): string {
  let output = redactPrivateKeyBlocks(value, replacement);
  for (const pattern of CREDENTIAL_SHAPES) output = output.replace(pattern, () => replacement);
  return output.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${replacement}@`);
}
