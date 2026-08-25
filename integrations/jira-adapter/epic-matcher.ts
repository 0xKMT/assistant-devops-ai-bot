/** Deterministic policy for accepting an untrusted Epic ranking. */
import type { JiraEpicCandidate, JiraEpicConfidence } from "@friday/shared";

export interface RankedEpic {
  readonly key: string;
  readonly confidence: JiraEpicConfidence;
  readonly evidence: string;
}

/** Returns a suggestion only when the model selected a retrieved candidate with high confidence. */
export function selectSuggestedEpic(
  candidates: readonly JiraEpicCandidate[],
  ranked: RankedEpic | null | undefined,
): string | null {
  if (!ranked || ranked.confidence !== "high") return null;
  return candidates.some((candidate) => candidate.key === ranked.key) ? ranked.key : null;
}
