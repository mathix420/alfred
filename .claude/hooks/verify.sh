#!/usr/bin/env bash
# Claude Code *Stop* hook — keep the tree green before Claude finishes a turn.
#
# Runs the project gates (format auto-fix → lint → typecheck → test). If any
# fail, it prints the output to stderr and exits 2, which blocks the stop and
# hands the failure back to Claude so it gets fixed before the turn ends.
#
# Reads the hook payload on stdin; honours `stop_hook_active` so a blocked stop
# that Claude is already retrying won't trigger an infinite loop.
set -uo pipefail

input="$(cat)"
if printf '%s' "$input" | tr -d ' \n\t' | grep -q '"stop_hook_active":true'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# GUI-launched sessions (e.g. the pen.dev app) don't source the shell profile,
# so bun's install dir may be missing from PATH.
command -v bun >/dev/null 2>&1 || export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || { echo "Stop hook: bun not found, skipping checks" >&2; exit 0; }

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
fail=0

for step in format lint typecheck test; do
  case "$step" in
    test) cmd=(bun test) ;;
    *) cmd=(bun run "$step") ;;
  esac
  printf '\n## %s\n' "$step" >>"$log"
  if ! "${cmd[@]}" >>"$log" 2>&1; then
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Stop hook: project checks failed — fix these before finishing:" >&2
  cat "$log" >&2
  exit 2
fi
exit 0
