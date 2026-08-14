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
    sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)"
    [ -z "$sid" ] && exit 0
    case "$sid" in *[!A-Za-z0-9._-]*) exit 0 ;; esac

    pct="$(jq -r '.ctx.pct // empty' "$CONFIG_DIR/corral-status/$sid.json" 2>/dev/null || true)"
    [ -z "$pct" ] && exit 0

    thresholds_file="${CORRAL_HOME:-$HOME/.corral}/config.json"
    thresholds="$(jq -r '
      (.hooks.ctxThresholds // [30,40,60]) as $t
      | if ($t|type)=="array" and ($t|length)==3 and ($t|all(type=="number")) and ($t[0]<$t[1]) and ($t[1]<$t[2])
        then "\($t[0]) \($t[1]) \($t[2])"
        else "30 40 60" end
    ' "$thresholds_file" 2>/dev/null || echo "30 40 60")"
    [ -z "$thresholds" ] && thresholds="30 40 60"
    # shellcheck disable=SC2086
    set -- $thresholds
    t1="$1"; t2="$2"; t3="$3"

    band="$(jq -n -r --argjson p "$pct" --argjson t1 "$t1" --argjson t2 "$t2" --argjson t3 "$t3" '
      if $p < $t1 then empty
      elif $p < $t2 then "notice"
      elif $p < $t3 then "nudge"
      else "urgent" end' 2>/dev/null || true)"
    [ -z "$band" ] && exit 0

    emit "[corral] ctx ${pct}% (${band})"
    ;;
esac
