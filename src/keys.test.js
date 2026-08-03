import assert from "node:assert/strict";
import { test } from "node:test";
import * as keys from "./keys.js";

const KEYS = {
  scope: "pr-928",
  workflow: "Dependabot Review",
  runId: "30135291743",
  runAttempt: "1",
};

test("keys the session on the work item and the workflow", () => {
  assert.deepEqual(keys.cacheKeys(KEYS), {
    base: "claude-session-v2--pr-928--Dependabot-Review",
    restore: "claude-session-v2--pr-928--Dependabot-Review--",
    save: "claude-session-v2--pr-928--Dependabot-Review--30135291743-1",
  });
});

test("gives two concurrent pull requests non-overlapping keys", () => {
  const a = keys.cacheKeys({ ...KEYS, scope: "pr-928" });
  const b = keys.cacheKeys({ ...KEYS, scope: "pr-929" });

  assert.notEqual(a.base, b.base);
  assert.ok(!b.base.startsWith(a.restore));
  assert.ok(!a.base.startsWith(b.restore));
  assert.ok(!b.save.startsWith(a.restore));
});

test("keeps a shorter work item from prefix-matching a longer one", () => {
  const short = keys.cacheKeys({ ...KEYS, scope: "issue-64" });
  const long = keys.cacheKeys({ ...KEYS, scope: "issue-642" });
  assert.ok(!long.save.startsWith(short.restore));
  assert.ok(!short.save.startsWith(long.restore));
});

test("separates workflows working on the same pull request", () => {
  const review = keys.cacheKeys({ ...KEYS, workflow: "Dependabot Review" });
  const response = keys.cacheKeys({ ...KEYS, workflow: "PR Review Response" });
  assert.ok(!response.base.startsWith(review.restore));
  assert.ok(!review.base.startsWith(response.restore));
});

test("collapses characters that would break the key separator", () => {
  // "--" is the field separator, so no slug may contain one of its own.
  const { base } = keys.cacheKeys({
    ...KEYS,
    scope: "pr--928",
    workflow: "A/B Review",
  });
  assert.equal(base, "claude-session-v2--pr-928--A-B-Review");
});

test("carries no branch or ref component", () => {
  // A branch in the key would split one work item's session across the triggers
  // that act on it, each running under a different ref.
  assert.ok(!keys.cacheKeys(KEYS).base.includes("refs"));
});

test("saves under a key unique to the run and attempt", () => {
  const first = keys.cacheKeys({ ...KEYS, runAttempt: "1" }).save;
  const second = keys.cacheKeys({ ...KEYS, runAttempt: "2" }).save;
  assert.notEqual(first, second);
  // Cache entries are immutable, so a re-run must not collide with the original.
  assert.ok(second.startsWith(keys.cacheKeys(KEYS).restore));
});

test("refuses to key a session with no work item", () => {
  assert.throws(() => keys.cacheKeys({ ...KEYS, scope: "" }), /scope/i);
  assert.throws(() => keys.cacheKeys({ ...KEYS, scope: "  " }), /scope/i);
});
