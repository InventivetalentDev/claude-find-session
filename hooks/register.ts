import type { Register } from 'claude-code'

// Runs under `python3 -I -` so the module needs no file of its own on disk.
const SEARCH = String.raw`
# Searches what people and assistants said in Claude Code and Codex sessions.
# Usage: python3 -I search.py <term> [limit]
# Tool calls and tool output are skipped, so a term in a file dump doesn't match.
import glob
import json
import os
import sys
import time

HOME = os.path.expanduser("~")
CLAUDE_DIRS = [
    (os.path.join(HOME, ".claude-hp", "projects"), "claude-hp"),
    (os.path.join(HOME, ".claude", "projects"), "claude"),
]
CODEX_DIR = os.path.join(HOME, ".codex", "sessions")


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


def codex_texts(line):
    payload = line.get("payload") or {}
    if line.get("type") != "event_msg":
        return
    if payload.get("type") == "user_message":
        text = payload.get("message") or ""
        if not text.startswith("<"):
            yield "you", text
    elif payload.get("type") == "agent_message":
        yield "codex", payload.get("message") or ""


def scan(path, term, texts):
    with open(path, "rb") as f:
        raw = f.read()
    if term.encode() not in raw.lower():
        return None
    hit = {"path": path, "mtime": os.path.getmtime(path), "cwd": None, "id": None,
           "last": "", "count": 0, "first": None, "firstYou": None}
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
        if line.get("type") == "session_meta":
            hit["id"] = (line.get("payload") or {}).get("id")
        for who, text in texts(line):
            if term in text.lower():
                hit["count"] += 1
                found = who + ": " + snippet(text, term)
                hit["first"] = hit["first"] or found
                if who == "you" and not hit["firstYou"]:
                    hit["firstYou"] = found
    return hit if hit["count"] else None


def main():
    term = sys.argv[1].lower()
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    exclude = sys.argv[3] if len(sys.argv) > 3 else ""
    hits = []
    for root, profile in CLAUDE_DIRS:
        for path in glob.glob(os.path.join(root, "*", "*.jsonl")):
            sid = os.path.basename(path)[:-len(".jsonl")]
            if sid == exclude:
                continue
            hit = scan(path, term, claude_texts)
            if hit:
                hit["id"] = sid
                cmd = "claude-hp" if profile == "claude-hp" else "claude"
                hit["source"] = profile
                hit["resume"] = cmd + " --resume " + sid
                hits.append(hit)
    for path in glob.glob(os.path.join(CODEX_DIR, "**", "*.jsonl"), recursive=True):
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
        cwd = (h["cwd"] or "?").replace(HOME, "~")
        print(when + "  [" + h["source"] + "]  " + cwd + "  (" + str(h["count"]) + " hit"
              + ("s" if h["count"] != 1 else "") + ")")
        print("  " + (h["firstYou"] or h["first"]))
        print("  cd " + cwd + " && " + h["resume"] + "\n")


main()
`

const USAGE = 'Usage: /find-session <term> [limit]. Example: /find-session dialog 30'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'find-session',
      description: 'Search what was said in all Claude Code and Codex sessions, across projects',
    })

    return next(e)
  })

  on('command.run', { command: 'find-session' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const last = words[words.length - 1] ?? ''
    const limit = words.length > 1 && /^\d+$/.test(last) ? words.pop()! : '15'
    const term = words.join(' ')
    if (!term) return { text: USAGE }

    const own = await $.session.id()
    const { exitCode, stdout, stderr } = await $.process.run(
      ['python3', '-I', '-', term, limit, own],
      { stdin: SEARCH, timeoutMs: 120_000 },
    )
    if (exitCode !== 0) return { text: `find-session failed (exit ${exitCode}):\n${stderr.trim()}` }

    return { text: stdout.trimEnd() }
  })
}
