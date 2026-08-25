import assert from "node:assert/strict";
import test from "node:test";
import { githubSlug } from "../lib/git-remote.mjs";

test("normalizes matching GitHub HTTPS and SSH origins", () => {
  assert.equal(githubSlug("https://github.com/Everfit-io/gitops.git"), "everfit-io/gitops");
  assert.equal(githubSlug(["git", "github.com:Everfit-io/gitops.git"].join("@")), "everfit-io/gitops");
});

test("rejects non-GitHub hosts and malformed origins", () => {
  assert.equal(githubSlug(["git", "gitlab.com:Everfit-io/gitops.git"].join("@")), "");
  assert.equal(githubSlug("https://github.example.com/Everfit-io/gitops.git"), "");
  assert.equal(githubSlug("file:///tmp/gitops"), "");
});
