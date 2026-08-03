import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as session from "./session.js";

const SESSION_ID = "9d720495-1008-4c72-86ac-09f8d5886ad5";
const PROJECT_SLUG = "-home-runner-work-ui-ui";

/** A transcript in which every subagent the session launched also reported back. */
const SETTLED = [
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Task", input: {} }],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: "Review complete." },
  }),
].join("\n");

/**
 * A ~/.claude directory as a restore would leave it: the recorded id and scope
 * in session-meta, and the transcript itself under a project slug.
 */
function makeClaudeHome({
  recordedId = SESSION_ID,
  recordedScope = "pr-928",
  transcriptId = SESSION_ID,
  transcript = SETTLED,
  strayTranscriptId = null,
  subagentOf = null,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  const project = path.join(home, "projects", PROJECT_SLUG);
  fs.mkdirSync(project, { recursive: true });

  const meta = path.join(home, "session-meta");
  fs.mkdirSync(meta, { recursive: true });
  if (recordedId !== null) {
    fs.writeFileSync(path.join(meta, "session-id"), `${recordedId}\n`);
  }
  if (recordedScope !== null) {
    fs.writeFileSync(path.join(meta, "scope"), `${recordedScope}\n`);
  }

  if (transcriptId !== null) {
    fs.writeFileSync(path.join(project, `${transcriptId}.jsonl`), `${transcript}\n`);
  }
  if (strayTranscriptId) {
    fs.writeFileSync(path.join(project, `${strayTranscriptId}.jsonl`), `${SETTLED}\n`);
  }
  if (subagentOf) {
    const subagents = path.join(project, subagentOf, "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, "agent-a97937ac7a97ff6e3.jsonl"), `${SETTLED}\n`);
  }
  return home;
}

const resolve = (home, scope = "pr-928") => session.resolveSession(home, scope);

test("resumes the recorded session when its transcript is present", () => {
  assert.deepEqual(resolve(makeClaudeHome()), {
    id: SESSION_ID,
    args: `--resume ${SESSION_ID}`,
  });
});

test("starts fresh when the recorded transcript is missing", () => {
  assert.deepEqual(resolve(makeClaudeHome({ transcriptId: null })), {
    id: "",
    args: "",
  });
});

test("never substitutes an arbitrary transcript when no id was recorded", () => {
  // A foreign session's transcript is the newest .jsonl on disk; resuming it
  // answers a review from a conversation about another work item.
  const home = makeClaudeHome({
    recordedId: null,
    recordedScope: null,
    transcriptId: null,
    strayTranscriptId: "11111111-2222-3333-4444-555555555555",
  });
  assert.deepEqual(resolve(home), { id: "", args: "" });
});

test("refuses a session recorded under a different work item", () => {
  const home = makeClaudeHome({ recordedScope: "pr-929" });
  assert.deepEqual(resolve(home, "pr-928"), { id: "", args: "" });
});

test("rejects a recorded id that is not a session id", () => {
  const home = makeClaudeHome({
    recordedId: "../../../etc/passwd",
    transcriptId: null,
  });
  assert.deepEqual(resolve(home), { id: "", args: "" });
});

test("refuses a transcript with unresolved background task work", () => {
  // Resuming it spends the run's only turn replaying the orphaned task
  // notifications, so the prompt is never read.
  const poisoned = [
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "bn35jeqst", name: "Task", input: {} }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "Kicked off a subagent." },
    }),
  ].join("\n");
  assert.deepEqual(resolve(makeClaudeHome({ transcript: poisoned })), {
    id: "",
    args: "",
  });
});

test("refuses a transcript that already replayed orphaned tasks", () => {
  const orphaned = [
    SETTLED,
    JSON.stringify({
      type: "system",
      subtype: "task_notification",
      status: "stopped",
      message: "Orphaned by a previous Claude Code process exit",
    }),
  ].join("\n");
  assert.deepEqual(resolve(makeClaudeHome({ transcript: orphaned })), {
    id: "",
    args: "",
  });
});

test("starts fresh when nothing was restored at all", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  assert.deepEqual(resolve(home), { id: "", args: "" });
});

test("starts fresh rather than resuming an unreadable transcript", () => {
  const home = makeClaudeHome({ transcript: "not json at all" });
  assert.deepEqual(resolve(home), { id: "", args: "" });
});

test("reads a transcript whose last line was truncated by a crash", () => {
  // Only a transcript with nothing parseable is unusable. A half-written final
  // line is what a killed agent leaves behind, and the session before it is
  // still worth resuming.
  const home = makeClaudeHome({ transcript: `${SETTLED}\n{"type":"assis` });
  assert.equal(resolve(home).id, SESSION_ID);
});

test("caches transcripts positively rather than excluding auto-memory", () => {
  // actions/cache archives a matched directory whole, so a `!` negation below an
  // included ancestor is ignored (actions/toolkit#713). Matching the transcripts
  // themselves leaves ~/.claude/projects/*/memory out by construction — that
  // store is repo-wide and belongs to claude-code-memory, not to one work item.
  assert.deepEqual(session.cachePaths("/home/runner/.claude"), [
    "/home/runner/.claude/projects/*/*.jsonl",
    "/home/runner/.claude/session-meta",
  ]);
  for (const pattern of session.cachePaths("/home/runner/.claude")) {
    assert.ok(!pattern.startsWith("!"));
  }
});

test("finds the session this job just wrote", () => {
  const home = makeClaudeHome({ transcriptId: null });
  const project = path.join(home, "projects", PROJECT_SLUG);
  fs.writeFileSync(path.join(project, `${SESSION_ID}.jsonl`), `${SETTLED}\n`);
  assert.equal(session.latestSessionId(home, 0), SESSION_ID);
});

test("ignores a transcript older than the job", () => {
  const home = makeClaudeHome();
  const stale = path.join(home, "projects", PROJECT_SLUG, `${SESSION_ID}.jsonl`);
  const hour = 60 * 60 * 1000;
  fs.utimesSync(stale, new Date(Date.now() - hour), new Date(Date.now() - hour));
  // Restored from a previous run's cache rather than written by this job's
  // agent, so it is not what this run has to save.
  assert.equal(session.latestSessionId(home, Date.now() - hour / 2), "");
});

test("never reports a subagent transcript as the session", () => {
  // Claude Code writes subagent transcripts to <session-id>/subagents/agent-*.jsonl.
  // Resuming one of those resumes a subagent, not the conversation.
  const home = makeClaudeHome({ transcriptId: null, subagentOf: SESSION_ID });
  assert.equal(session.latestSessionId(home, 0), "");
});

test("prefers the most recently written session", () => {
  const home = makeClaudeHome();
  const project = path.join(home, "projects", PROJECT_SLUG);
  const newer = "22222222-3333-4444-5555-666666666666";
  fs.writeFileSync(path.join(project, `${newer}.jsonl`), `${SETTLED}\n`);
  const older = path.join(project, `${SESSION_ID}.jsonl`);
  fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  // A job that runs several agents in turn resumes where the last one left off.
  assert.equal(session.latestSessionId(home, 0), newer);
});

test("ignores a file whose name is not a session id", () => {
  const home = makeClaudeHome({ transcriptId: null });
  const project = path.join(home, "projects", PROJECT_SLUG);
  fs.writeFileSync(path.join(project, "notes.jsonl"), `${SETTLED}\n`);
  assert.equal(session.latestSessionId(home, 0), "");
});
