// Deciding which session a run may resume, and which session a run has to save.
// Filesystem reads only, so both halves are testable against a temporary
// ~/.claude directory.

import fs from "node:fs";
import path from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code has already replayed the queued notifications of a session that exited with subagents running. */
const ORPHANED = "Orphaned by a previous Claude Code process exit";

export function isSessionId(value) {
  return SESSION_ID.test(String(value ?? "").trim());
}

const NOT_RESUMABLE = { id: "", args: "" };

function read(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function projectDirs(claudeHome) {
  const projects = path.join(claudeHome, "projects");
  try {
    return fs
      .readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projects, entry.name));
  } catch {
    return [];
  }
}

/**
 * Transcripts of whole conversations, which is what `--resume` takes. Subagent
 * transcripts live a level down in `<session-id>/subagents/agent-*.jsonl`, so
 * reading only the top level of a project directory and only names that are
 * session ids leaves them out by construction — resuming one of those would
 * resume a subagent rather than the conversation that launched it.
 */
function transcripts(claudeHome) {
  return projectDirs(claudeHome).flatMap((project) => {
    let entries = [];
    try {
      entries = fs.readdirSync(project, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".jsonl") &&
          isSessionId(entry.name.slice(0, -".jsonl".length)),
      )
      .map((entry) => ({
        id: entry.name.slice(0, -".jsonl".length),
        file: path.join(project, entry.name),
      }));
  });
}

// What the cache entry covers. Only the transcript files and the recorded id,
// never a whole project directory: auto-memory lives in a `memory` directory
// beside the transcripts, is repo-wide knowledge cached under its own key by
// claude-code-memory, and must not be scoped to one work item. Excluding it with
// a `!` negation does not work — actions/cache archives a matched directory
// whole, so a negation below an included ancestor is silently ignored
// (actions/toolkit#713). Matching the transcripts positively leaves memory out by
// construction.
export function cachePaths(claudeHome) {
  return [`${claudeHome}/projects/*/*.jsonl`, `${claudeHome}/session-meta`];
}

function transcriptFor(claudeHome, sessionId) {
  return transcripts(claudeHome).find((entry) => entry.id === sessionId)?.file ?? "";
}

/**
 * Why this transcript must not be resumed, or `null` when it may be.
 *
 * A session that exited with subagents still running comes back with orphaned
 * task notifications queued. Resuming it spends the run's only turn replaying
 * them, so the prompt is never read.
 */
export function transcriptProblem(text) {
  if (text.includes(ORPHANED)) {
    return "the transcript already replayed orphaned background tasks";
  }

  const started = new Map();
  const finished = new Set();
  let parsed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A half-written final line is what a killed agent leaves behind. Only a
      // transcript with nothing parseable in it is unusable.
      continue;
    }
    parsed += 1;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (
        part?.type === "tool_use" &&
        (part?.name === "Task" || part?.name === "Agent") &&
        part?.id
      ) {
        started.set(part.id, true);
      }
      if (part?.type === "tool_result" && part?.tool_use_id) {
        finished.add(part.tool_use_id);
      }
    }
  }

  if (parsed === 0) {
    return "the transcript could not be parsed";
  }
  const unresolved = [...started.keys()].filter((id) => !finished.has(id));
  if (unresolved.length > 0) {
    return `the transcript has ${unresolved.length} unresolved background task(s)`;
  }
  return null;
}

/**
 * Decide whether the restored cache holds a session this run may resume, and say
 * why not when it does not.
 *
 * The only resumable session is the one whose id an earlier run of this workflow
 * recorded for this work item. Nothing else qualifies — never "the newest
 * transcript on disk", because the newest transcript may belong to another work
 * item entirely. Every check falls back to starting fresh.
 */
export function resolveSession(claudeHome, scope, log = () => {}) {
  const fresh = (reason) => {
    log(`No session to resume (${reason}); the agent will start fresh.`);
    return NOT_RESUMABLE;
  };

  const meta = path.join(claudeHome, "session-meta");
  const recordedId = read(path.join(meta, "session-id"));
  const recordedScope = read(path.join(meta, "scope"));

  if (!recordedId) {
    return fresh("no session id was recorded alongside the cache entry");
  }
  if (!recordedScope) {
    return fresh("the cache entry records no work item");
  }
  if (!isSessionId(recordedId)) {
    return fresh("the recorded session id is not a session id");
  }
  // Belt and braces: the cache key is already scoped to the work item, so a
  // mismatch here means a key collision or a hand-edited cache.
  if (recordedScope !== scope) {
    return fresh(`the cached session belongs to ${recordedScope}, not ${scope}`);
  }

  const file = transcriptFor(claudeHome, recordedId);
  if (!file) {
    return fresh(`the transcript for ${recordedId} is not in the restored cache`);
  }
  const problem = transcriptProblem(read(file));
  if (problem) {
    return fresh(problem);
  }

  log(`Resuming Claude session ${recordedId} for ${scope}.`);
  return { id: recordedId, args: `--resume ${recordedId}` };
}

/**
 * The session this job produced: the most recently written conversation
 * transcript, ignoring anything already on disk when the job started.
 *
 * The mtime cut-off is what separates this job's work from the previous run's
 * transcripts, which the restore laid down with their original timestamps. A job
 * that runs several agents in turn saves the last of them, which is the one a
 * follow-up run should continue.
 */
export function latestSessionId(claudeHome, startedAtMs) {
  let latest = { id: "", mtimeMs: -1 };
  for (const entry of transcripts(claudeHome)) {
    let stat;
    try {
      stat = fs.statSync(entry.file);
    } catch {
      continue;
    }
    if (stat.mtimeMs >= startedAtMs && stat.mtimeMs > latest.mtimeMs) {
      latest = { id: entry.id, mtimeMs: stat.mtimeMs };
    }
  }
  return latest.id;
}
