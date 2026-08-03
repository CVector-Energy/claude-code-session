// Cache key derivation, kept free of Actions plumbing so it can be tested without
// a runner.

export const KEY_PREFIX = "claude-session-v2";

/** Separates the fields of a key. No slug may contain one of its own. */
const SEPARATOR = "--";

/**
 * Keep `[A-Za-z0-9_.]` and collapse every other run of characters into a single
 * `-`. Collapsing is what keeps a slug from growing a `--` of its own, which
 * would let a shorter work item prefix-match a longer one.
 */
export function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_.]+/g, "-");
}

/**
 * Session identity is (work item, workflow) — never the branch and never the
 * repository. Two pull requests are two work items, so neither can ever see the
 * other's transcripts, and two workflows acting on one pull request each keep
 * their own conversation.
 *
 * Cache entries are immutable, so every run saves under its own key and restores
 * by the work-item prefix, picking up the most recent entry for this work item
 * and workflow. There is deliberately no broader fallback: a run that finds
 * nothing starts fresh, which costs one extra agent run and is always preferable
 * to answering from a foreign conversation.
 */
export function cacheKeys({ scope, workflow, runId, runAttempt }) {
  if (!String(scope ?? "").trim()) {
    throw new Error("scope is required (for example pr-928 or issue-934)");
  }
  const base = [KEY_PREFIX, slug(scope), slug(workflow)].join(SEPARATOR);
  return {
    base,
    restore: `${base}${SEPARATOR}`,
    save: `${base}${SEPARATOR}${runId}-${runAttempt}`,
  };
}
