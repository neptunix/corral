#!/usr/bin/env bash
# corral-claude-hook.sh
# Claude Code hook, registered under both SessionStart and UserPromptSubmit, branching on
# hook_event_name from the hook-input JSON on stdin. See docs/superpowers/specs/2026-08-13-
# context-pressure-notice-design.md for the full design.
# Best-effort throughout: any failure exits 0 silently, same contract as corral-status-capture.sh
# — never blocks prompt submission or session start.
set -euo pipefail
trap 'exit 0' ERR

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
input="$(cat)"

event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
[ -z "$event" ] && exit 0
case "$event" in
  SessionStart|UserPromptSubmit) : ;;
  *) exit 0 ;;
esac

# Both branches require the skill: an un-primed session gets a raw signal with no explanation.
skill_file="$CONFIG_DIR/skills/corral/SKILL.md"
[ -f "$skill_file" ] || exit 0

emit() {
  jq -n -c --arg event "$event" --arg ctx "$1" \
    '{hookSpecificOutput: {hookEventName: $event, additionalContext: $ctx}}'
}

case "$event" in
  SessionStart)
    block="$(awk '/<!-- ctx-signal:start -->/{flag=1; next} /<!-- ctx-signal:end -->/{flag=0} flag' "$skill_file")"
    [ -z "$block" ] && exit 0
    emit "$block"
    ;;
  UserPromptSubmit)
    :
    ;;
esac
