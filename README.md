# find-session

A Claude Code mod that adds `/find-session`: a full-text search over your past Claude Code and Codex sessions, in every project, with a command to resume each match.

The built-in `/resume` lists sessions from the current project and searches their titles. `/find-session` searches what you and the assistant actually said, wherever the session ran.

```
/find-session dialog
/find-session settings dialog 30
```

```
23 session(s) mention "dialog", newest 15 shown:

2026-10-29 11:54 UTC  [claude]  ~/Projects/my-app  (7 hits)
  you: in a new worktree, look into adding a confirmation dialog to the settings page…
  cd ~/Projects/my-app && claude --resume 3f2a9c1e-5b7d-4e2a-9c61-8d0f4b2e7a15

2026-10-28 14:26 UTC  [codex]  ~/Projects/website  (3 hits)
  codex: …the existing dialogs, API client, and grid provide the needed patterns…
  cd ~/Projects/website && codex resume 01a182bd-0f54-79a1-80f1-cea4d45c6080
```

## What it searches

- Your messages and the assistant's replies, case-insensitive. Multi-word terms match as one phrase.
- Not tool calls or tool output, so a term inside a file dump doesn't match.
- Not compacted summaries, subagent turns, or the session you run it from.

Results are sorted by each session's last message. A number after the term sets how many are shown.

## Install

Python 3 must be on your `PATH` (it ships with macOS and most Linux distributions).

At the prompt of a Claude Code terminal session:

```
/plugin install find-session --marketplace inventivetalentdev/find-session
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install find-session --marketplace inventivetalentdev/find-session
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `inventivetalentdev/find-session`, then **Add plugin**.

## Settings

Set these in `/config`, or in `settings.json` under `pluginConfigs`:

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeDirs` | empty | Claude Code config folders to search. Empty means `~/.claude`, `$CLAUDE_CONFIG_DIR`, and any other `~/.claude*` folder that holds a `projects/` folder. |
| `codexDir` | empty | Codex session logs. Empty means `$CODEX_HOME/sessions`, else `~/.codex/sessions`. Set to `off` to skip Codex. |
| `limit` | `15` | How many sessions to list when you don't type a number. |
| `python` | `python3` | The Python 3 command. Use `python` on Windows. |

### Resume commands for extra config folders

Sessions in `~/.claude` resume with `claude --resume <id>`. Sessions in any other folder resume with `CLAUDE_CONFIG_DIR=<folder> claude --resume <id>`.

If you start that profile with your own alias, add `=<alias>` to its `claudeDirs` entry:

```json
{
  "pluginConfigs": {
    "find-session": {
      "options": {
        "claudeDirs": ["~/.claude", "~/.claude-work=claude-work"]
      }
    }
  }
}
```

## Limits

- Each run reads every session file. On a few hundred sessions that takes a few seconds.
- Compressed Codex logs (`.jsonl.zst`) are skipped.

## License

MIT
