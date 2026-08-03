# Claude Code Session Action

Carry a [Claude Code](https://claude.com/claude-code) session between CI runs on the same work item, so a second round of review comments continues the conversation the first round started instead of re-reading the repository from scratch. The session is saved to the cache at the job-end hook.

Where [claude-code-memory](https://github.com/CVector-Energy/claude-code-memory) carries what an agent has learned about the *repository*, this action carries one *conversation*: the transcript of the agent's work on a single pull request or issue.

## What This Action Does

1. Derives a cache key from the work item and the workflow — never the branch
2. Restores the transcript an earlier run of this workflow saved for this work item
3. Decides whether that session is safe to resume, and reports `--resume <id>` when it is
4. Registers a post step that saves this run's session when the job finishes, pass or fail
5. Works out which session that is on its own, so a job that runs several agents needs no bookkeeping

## Usage

```yaml
jobs:
  respond:
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Restore the Claude session for this PR
        id: session
        uses: CVector-Energy/claude-code-session@v1
        with:
          scope: pr-${{ github.event.pull_request.number }}

      - name: Run Claude Code
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude_args: --model claude-opus-5 ${{ steps.session.outputs.resume-args }}
          prompt: Address the review comments.
```

One step, declared before the agent. There is nothing to add after it and nothing to add for a job that fails: the save is a post step that runs either way, and it finds this run's session itself.

## Inputs

| Input | Description | Required |
|-------|-------------|----------|
| `scope` | The work item this session belongs to, such as `pr-928` or `issue-934` | Yes |

## Outputs

| Output | Description |
|--------|-------------|
| `resume-args` | `--resume <id>` when a resumable session was restored, otherwise empty. Append verbatim to the agent's arguments. |
| `session-id` | The session id the agent will resume, or empty when it starts fresh |
| `resumed` | `"true"` when a session was restored and the agent will continue it |

## How It Works

**A session belongs to a work item and a workflow, not to a branch.** The cache key is `claude-session-v2--<scope>--<workflow>`, so two pull requests can never see each other's transcripts, and two workflows acting on the same pull request each keep their own conversation. Cache entries are immutable, so every run saves under a key unique to the run and restores by the work-item prefix, picking up the most recent entry. There is deliberately no broader fallback: a branch-wide or repo-wide key is what lets a run answer a review from a conversation about something else.

**Only a session an earlier run vouched for is resumed.** The save records the session id inside the cache entry alongside the transcript. The restore resumes that id and nothing else — never "the newest transcript on disk", because on a cache hit the newest transcript may belong to another work item. Each of these makes a run start fresh instead, which costs one extra agent run:

- no session id was recorded alongside the entry, or the recorded work item is not this one
- the recorded transcript is not in the restored cache
- the transcript shows unresolved `Task` calls, or has already replayed orphaned task notifications. A session that exited with subagents still running comes back with those notifications queued, and resuming it spends the run's only turn replaying them — so the prompt is never read.

**The save finds the session by itself.** On the way out, the action saves the most recently written conversation transcript that did not exist when the job started. A job that runs several agents in turn therefore saves the last of them, which is the one a follow-up run should continue, without the caller having to thread session ids between steps. Subagent transcripts live a level down, under `<session-id>/subagents/`, so they are never mistaken for the conversation that launched them.

To name a specific session instead, set `CLAUDE_CODE_SESSION_ID` before the job ends — the only way to hand the post step a value that did not exist when the main step ran:

```yaml
      - name: Run Claude Code
        id: agent
        uses: anthropics/claude-code-action@v1
        # ...

      - name: Save this agent's session rather than the newest one
        run: echo "CLAUDE_CODE_SESSION_ID=${{ steps.agent.outputs.session_id }}" >> "$GITHUB_ENV"
```

**Auto-memory is left alone.** The cache entry covers `~/.claude/projects/*/*.jsonl` and `~/.claude/session-meta`, matched positively so that the repo-wide auto-memory store beside the transcripts stays out of a work-item-scoped entry. A `!` exclusion would not do it: `actions/cache` archives a matched directory whole, so a negation below an included ancestor is silently ignored ([actions/toolkit#713](https://github.com/actions/toolkit/issues/713)). Use claude-code-memory alongside this action to cache that store under its own key.

**Neither step can fail your job.** A cache miss is normal and a cache outage should not turn a build red, so both halves log a warning and carry on. The worst case is an agent that starts fresh.

## Concurrency

Two runs of the same workflow on the same work item at the same time will both try to save, and the second save loses — cache keys are immutable and include the run id, so nothing is corrupted, but one conversation is dropped. Serialise them:

```yaml
concurrency:
  group: ${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

## Cache Scope Limits

GitHub scopes cache reads to the current ref, its parents, and the default branch. Triggers that run under different refs — `pull_request_review` under `refs/pull/N/merge`, `issue_comment` under the default branch — cannot read each other's entries, so continuity holds per trigger family rather than across all of them. A run that cannot read the entry starts fresh and says so in the log.

## Development

```sh
npm install
npm test          # node --test over src/*.test.js
npm run build     # bundle src/ into the committed dist/
```

`dist/` is committed because the runner executes it directly. CI rebuilds it and fails if the result differs from what is checked in.

## License

MIT
