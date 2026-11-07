# Branch Reviewer

A local pull-request-style review UI for git servers that have no PRs (Bonobo Git Server and similar). It has Claude built in.

- Branch list with author, age, ahead/behind, and review status ("Changes requested", "new commits").
- Diff viewer: per-file collapse, a "Viewed" checkbox (resets when the file changes), hide-whitespace toggle.
- Inline comments on any line or file, with severity (blocker / major / minor / nit).
- **Review with Claude**: Claude reads the whole repo at the branch head, not just the diff. It returns findings anchored to lines, with explanations written for juniors, plus suggested fixes. You **Keep**, **Edit & keep**, or **Dismiss** each one.
- Verdict: Approve / Comment / Request changes.
- Re-review: when the junior pushes more commits, the branch shows "new commits". "Show only changes since then" diffs from the commit you last reviewed.
- Export the review as Markdown (copy or download) to send on Teams or email, or commit it on their branch.

## Requirements

- Node 18+ and git on PATH.
- Claude Code CLI (`claude`), logged in with your Claude subscription (Pro/Max). The reviewer runs `claude -p` with that login. No API key and no credits are needed: reviews use your plan's normal usage limits.
- VPN only for **Fetch** and cloning. Reviewing works offline on what you last fetched.

## Run

```
start.bat            (or: npm start)
```

Open http://localhost:4777, then:

1. **Add repo**: give the folder of an existing clone. Or give a folder plus the Bonobo clone URL to clone it.
2. **Fetch** (VPN on) to get the juniors' latest branches.
3. Pick a branch. Read the diff, comment, and click **Review with Claude**.
4. Set a verdict, then **Export review** and send it.

## Settings

- **Model**: blank uses your Claude Code default. Set `opus` or `sonnet` to choose.
- **Guidelines**: team rules Claude should enforce. Set them globally and per repo. A `CLAUDE.md` in the repo is also read.
- **Default base branch**: per repo. Auto-detected otherwise (`origin/HEAD`, then main/master/develop).

## How it is safe

- Binds to `127.0.0.1` only. Rejects other Host headers and cross-site POSTs.
- Never touches your working copy. Claude reviews in a separate detached worktree under `data/worktrees/`.
- Claude gets read-only tools only (`Read`, `Grep`, `Glob`). It cannot run commands or edit files.
- Reviews are stored as JSON under `data/reviews/`. Delete `data/` to reset.

## Env vars

- `PORT`: default 4777.
- `CLAUDE_BIN`: path to the claude executable, if it is not on PATH.

## Tests

```
npm test
```
