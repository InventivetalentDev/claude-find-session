import type { Register } from 'claude-code'

// Runs as `python3 -I - <config json>` with this text on stdin, so the module
// needs no file of its own on disk.
const SEARCH = String.raw`
# Searches what people and assistants said in Claude Code and Codex sessions.
# Tool calls and tool output are skipped, so a term in a file dump doesn't match.
import glob
import json
import os
import shlex
import sys
import time

HOME = os.path.expanduser("~")
DEFAULT_CLAUDE = os.path.realpath(os.path.join(HOME, ".claude"))


def tilde(path):
    return "~" + path[len(HOME):] if path == HOME or path.startswith(HOME + os.sep) else path


def shell_path(path):
    short = tilde(path)
    return short if short == shlex.quote(short) or (short.startswith("~/") and " " not in short) \
        else shlex.quote(path)


def claude_dirs(entries, env_dir):
    # Each entry is "<folder>" or "<folder>=<resume launcher>".
    found = []
    if entries:
        for entry in entries:
            path, _, launcher = entry.partition("=")
            found.append((os.path.expanduser(path.strip()), launcher.strip()))
    else:
        candidates = [os.path.join(HOME, ".claude")]
        if env_dir:
            candidates.append(env_dir)
        candidates += sorted(glob.glob(os.path.join(HOME, ".claude*")))
        found = [(path, "") for path in candidates]

    dirs, seen = [], set()
    for path, launcher in found:
        real = os.path.realpath(path)
        if real in seen or not os.path.isdir(os.path.join(real, "projects")):
            continue
        seen.add(real)
        if not launcher:
            launcher = "claude" if real == DEFAULT_CLAUDE \
                else "CLAUDE_CONFIG_DIR=" + shell_path(real) + " claude"
        dirs.append((real, launcher))
    return dirs


def codex_dir(setting):
    if setting.strip().lower() == "off":
        return None
    if setting.strip():
        return os.path.expanduser(setting.strip())
    home = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    return os.path.join(home, "sessions")


def snippet(text, term):
    flat = " ".join(text.split())
    i = flat.lower().find(term)
    start = max(0, i - 60)
    end = min(len(flat), i + len(term) + 100)
    return ("…" if start > 0 else "") + flat[start:end] + ("…" if end < len(flat) else "")


def claude_texts(line):
    kind = line.get("type")
    if line.get("isMeta") or line.get("isSidechain") or line.get("isCompactSummary"):
        return
    content = (line.get("message") or {}).get("content")
    if kind == "user" and isinstance(content, str) and not content.startswith("<"):
        yield "you", content
    elif kind == "assistant" and isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                yield "claude", part.get("text") or ""


# Text Codex injects as user messages: instructions, environment, its reviewer.
CODEX_INJECTED = ("<", "# AGENTS.md", "The following is the Codex agent history")


def codex_texts(line):
    # Newer logs keep messages as response_item; older ones as event_msg.
    payload = line.get("payload") or {}
    kind = line.get("type")
    if kind == "response_item" and payload.get("type") == "message":
        who = {"user": "you", "assistant": "codex"}.get(payload.get("role"))
        for part in payload.get("content") or []:
            text = part.get("text") if isinstance(part, dict) else None
            if who and text and not (who == "you" and text.startswith(CODEX_INJECTED)):
                yield who, text
    elif kind == "event_msg" and payload.get("type") == "user_message":
        text = payload.get("message") or ""
        if not text.startswith(CODEX_INJECTED):
            yield "you", text
    elif kind == "event_msg" and payload.get("type") == "agent_message":
        yield "codex", payload.get("message") or ""


def scan(path, term, texts):
    with open(path, "rb") as f:
        raw = f.read()
    if term.encode() not in raw.lower():
        return None
    hit = {"path": path, "mtime": os.path.getmtime(path), "cwd": None, "id": None,
           "last": "", "count": 0, "first": None, "firstYou": None}
    seen = set()
    for raw_line in raw.splitlines():
        try:
            line = json.loads(raw_line)
        except ValueError:
            continue
        if not isinstance(line, dict):
            continue
        stamp = line.get("timestamp")
        if isinstance(stamp, str) and stamp > hit["last"]:
            hit["last"] = stamp
        hit["cwd"] = hit["cwd"] or line.get("cwd") or (line.get("payload") or {}).get("cwd")
        # A subagent's log holds its own session_meta, then its parent's.
        if line.get("type") == "session_meta" and not hit["id"]:
            hit["id"] = (line.get("payload") or {}).get("id")
        for who, text in texts(line):
            # A Codex log can hold the same message in both formats.
            if term in text.lower() and (who, text) not in seen:
                seen.add((who, text))
                hit["count"] += 1
                found = who + ": " + snippet(text, term)
                hit["first"] = hit["first"] or found
                if who == "you" and not hit["firstYou"]:
                    hit["firstYou"] = found
    return hit if hit["count"] else None


def main():
    config = json.loads(sys.argv[1])
    term = config["term"].lower()
    limit = int(config["limit"])
    hits = []
    for root, launcher in claude_dirs(config["claudeDirs"], config["envClaudeDir"]):
        for path in glob.glob(os.path.join(root, "projects", "*", "*.jsonl")):
            sid = os.path.basename(path)[:-len(".jsonl")]
            if sid == config["exclude"]:
                continue
            hit = scan(path, term, claude_texts)
            if hit:
                hit["id"] = sid
                hit["source"] = os.path.basename(root).lstrip(".") or root
                hit["resume"] = launcher + " --resume " + sid
                hits.append(hit)
    codex = codex_dir(config["codexDir"])
    if codex:
        for path in glob.glob(os.path.join(codex, "**", "*.jsonl"), recursive=True):
            hit = scan(path, term, codex_texts)
            if hit:
                hit["source"] = "codex"
                hit["resume"] = "codex resume " + (hit["id"] or path)
                hits.append(hit)

    hits.sort(key=lambda h: h["last"] or h["mtime"], reverse=True)
    if not hits:
        print("No sessions mention \"" + term + "\" in what was said.")
        return
    print(str(len(hits)) + " session(s) mention \"" + term + "\""
          + (", newest " + str(limit) + " shown" if len(hits) > limit else "") + ":\n")
    for h in hits[:limit]:
        when = h["last"][:16].replace("T", " ") + " UTC" if h["last"] else \
            time.strftime("%Y-%m-%d %H:%M", time.localtime(h["mtime"]))
        cwd = shell_path(h["cwd"]) if h["cwd"] else "?"
        print(when + "  [" + h["source"] + "]  " + tilde(h["cwd"] or "?") + "  (" + str(h["count"])
              + " hit" + ("s" if h["count"] != 1 else "") + ")")
        print("  " + (h["firstYou"] or h["first"]))
        print("  cd " + cwd + " && " + h["resume"] + "\n")


main()
`

const USAGE = 'Usage: /find-session <term> [limit]. Example: /find-session dialog 30'

// "<term words> [limit]": a trailing number is the limit when a term precedes it.
function parseArgs(args: string): { term: string; limit?: number } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const last = words[words.length - 1] ?? ''
  const limit = words.length > 1 && /^\d+$/.test(last) ? Number(words.pop()) : undefined

  return { term: words.join(' '), limit }
}

// Splits a line around each case-insensitive match of the term.
function splitMatches(line: string, term: string): { text: string; isMatch: boolean }[] {
  const parts: { text: string; isMatch: boolean }[] = []
  const lower = line.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(term); term && at !== -1; at = lower.indexOf(term, from)) {
    if (at > from) parts.push({ text: line.slice(from, at), isMatch: false })
    parts.push({ text: line.slice(at, at + term.length), isMatch: true })
    from = at + term.length
  }
  if (from < line.length) parts.push({ text: line.slice(from), isMatch: false })

  return parts
}

export const register: Register = (on, options) => {
  const claudeDirs = Array.isArray(options.claudeDirs) ? options.claudeDirs : []
  const codexDir = typeof options.codexDir === 'string' ? options.codexDir : ''
  const defaultLimit = typeof options.limit === 'number' ? options.limit : 15
  const python = typeof options.python === 'string' && options.python ? options.python : 'python3'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'find-session',
      description: 'Search what was said in all Claude Code and Codex sessions, across projects',
    })

    return next(e)
  })

  on('command.run', { command: 'find-session' }, async ($, e) => {
    const { term, limit = defaultLimit } = parseArgs(e.args)
    if (!term) return { text: USAGE }

    const config = {
      term,
      limit,
      exclude: await $.session.id(),
      claudeDirs,
      envClaudeDir: (await $.env.get('CLAUDE_CONFIG_DIR')) ?? '',
      codexDir,
    }
    const { exitCode, stdout, stderr } = await $.process.run(
      [python, '-I', '-', JSON.stringify(config)],
      { stdin: SEARCH, timeoutMs: 120_000 },
    )
    if (exitCode !== 0) return { text: `find-session failed (exit ${exitCode}):\n${stderr.trim()}` }

    return { text: stdout.trimEnd() }
  })

  // Draws the output as plain lines, not markdown, so snippets show as written,
  // with each session's heading in bold and the term highlighted.
  on('ui.render', { component: 'CommandOutput', props: { command: 'find-session' } }, async ($, e, next) => {
    if (e.component !== 'CommandOutput' || e.props.isErrored) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const term = parseArgs(e.props.args).term.toLowerCase()

    return (
      <Box flexDirection="column">
        {e.props.text.split('\n').map(line => (
          <Text bold={/^\d{4}-\d\d-\d\d /.test(line)}>
            {line === ''
              ? ' '
              : splitMatches(line, term).map(part =>
                  part.isMatch ? (
                    <Text color="warning" bold>
                      {part.text}
                    </Text>
                  ) : (
                    part.text
                  ),
                )}
          </Text>
        ))}
      </Box>
    )
  })
}
