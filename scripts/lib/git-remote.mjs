/** Returns owner/repository only for standard HTTPS or SSH GitHub origins. */
export function githubSlug(remote) {
  const value = String(remote ?? "").trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  return match?.[1]?.toLowerCase() ?? "";
}
