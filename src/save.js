import fs from "node:fs";
import path from "node:path";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { cachePaths, isSessionId, latestSessionId } from "./session.js";

/**
 * The session to carry forward. Normally the one this job's agents wrote, found
 * on disk — a caller that runs several agents does not have to work out which id
 * to keep. `CLAUDE_CODE_SESSION_ID` overrides it for a job that needs to name a
 * specific session, which is the only way to hand the post step a value produced
 * after the main step ran.
 */
function sessionToSave(claudeHome, startedAtMs) {
  const explicit = (process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (explicit) {
    core.info(`CLAUDE_CODE_SESSION_ID names ${explicit} as this run's session.`);
    return explicit;
  }
  return latestSessionId(claudeHome, startedAtMs);
}

async function run() {
  const key = core.getState("key");
  const scope = core.getState("scope");
  const claudeHome = core.getState("claude-home");
  if (!key || !scope || !claudeHome) {
    // The restore never ran — the step was skipped by an `if:` condition.
    return;
  }

  const id = sessionToSave(claudeHome, Number(core.getState("started-at") || 0));
  if (!id) {
    core.info(`No Claude session was written for ${scope}; nothing to save.`);
    return;
  }
  if (!isSessionId(id)) {
    core.warning(`Not saving ${scope}: "${id}" is not a session id.`);
    return;
  }

  // Recorded in the entry rather than inferred on the way back out, so the
  // restore resumes an id an earlier run vouched for instead of whatever
  // transcript happens to be newest then.
  const meta = path.join(claudeHome, "session-meta");
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, "session-id"), `${id}\n`);
  fs.writeFileSync(path.join(meta, "scope"), `${scope}\n`);

  try {
    // saveCache reports most failures by returning -1 and warning rather than by
    // throwing, so the success line has to be earned — a run that logs "saved"
    // and did not sends the next investigation to the wrong place.
    const cacheId = await cache.saveCache(cachePaths(claudeHome), key);
    if (cacheId > 0) {
      core.info(`Saved session ${id} for ${scope} as ${key}.`);
    } else {
      core.warning(
        `Session ${id} for ${scope} was not cached; the next run will start fresh.`,
      );
    }
  } catch (error) {
    // Includes ReserveCacheError when a re-run already stored this key. Losing a
    // save is not worth failing a job that has otherwise finished.
    core.warning(`Could not save the session cache: ${error.message}`);
  }
}

run().catch((error) => {
  core.warning(`claude-code-session: ${error.message}`);
});
