import fs from "node:fs";
import path from "node:path";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { cacheKeys } from "./keys.js";
import { cachePaths, resolveSession } from "./session.js";

async function run() {
  const scope = core.getInput("scope", { required: true }).trim();
  const claudeHome = path.join(process.env.HOME || "", ".claude");
  const keys = cacheKeys({
    scope,
    workflow: process.env.GITHUB_WORKFLOW || "",
    runId: process.env.GITHUB_RUN_ID || "0",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
  });

  // Handed to the post step, which is where the save happens. The scope travels
  // with them so the two halves cannot disagree about which work item this is —
  // the failure mode of the two separate actions this replaces, where a caller
  // had to repeat the scope and silently lost continuity if it drifted.
  core.saveState("scope", scope);
  core.saveState("key", keys.save);
  core.saveState("claude-home", claudeHome);
  core.saveState("started-at", String(Date.now()));

  const paths = cachePaths(claudeHome);
  try {
    const hit = await cache.restoreCache(paths, keys.base, [keys.restore]);
    core.info(
      hit
        ? `Restored ${scope}'s session cache from entry ${hit}.`
        : `No session cache for ${scope} yet.`,
    );
  } catch (error) {
    // A cache miss is normal and a cache outage is not worth failing a job over:
    // the agent starts fresh.
    core.warning(`Could not restore the session cache: ${error.message}`);
  }

  const { id, args } = resolveSession(claudeHome, scope, (message) =>
    core.info(message),
  );
  core.setOutput("session-id", id);
  core.setOutput("resume-args", args);
  core.setOutput("resumed", id ? "true" : "false");

  // The save needs something to match even when no agent runs, so that a run
  // which writes no transcript still leaves a well-formed entry behind.
  fs.mkdirSync(path.join(claudeHome, "session-meta"), { recursive: true });
}

run().catch((error) => {
  // Resuming is an optimisation; never fail the caller's job for it.
  core.warning(`claude-code-session: ${error.message}`);
  core.setOutput("session-id", "");
  core.setOutput("resume-args", "");
  core.setOutput("resumed", "false");
});
