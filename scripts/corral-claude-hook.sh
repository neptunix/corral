#!/usr/bin/env bash
# corral-claude-hook.sh
# Claude Code hook, registered under both SessionStart and UserPromptSubmit, branching on
# hook_event_name from the hook-input JSON on stdin. Two independent signals share this script:
# ctx-signal (context-pressure) and card-signal (card-empty, see
# docs/adr/0007-a-pane-side-hook-becomes-an-http-client-of-the-corral-api.md).
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

# Both signals require the skill: an un-primed session gets a raw signal with no explanation.
skill_file="$CONFIG_DIR/skills/corral/SKILL.md"
[ -f "$skill_file" ] || exit 0

emit() {
  jq -n -c --arg event "$event" --arg ctx "$1" \
    '{hookSpecificOutput: {hookEventName: $event, additionalContext: $ctx}}'
}

# Extracts the text between a named marker pair, e.g. block_of ctx-signal reads between
# "<!-- ctx-signal:start -->" and "<!-- ctx-signal:end -->". Each signal's own gate — not the other's
# — so a SKILL.md missing one marker pair silences only that signal.
block_of() {
  awk -v s="<!-- $1:start -->" -v e="<!-- $1:end -->" '$0==s{flag=1; next} $0==e{flag=0} flag' "$skill_file"
}

corral_home() { printf '%s' "${CORRAL_HOME:-$HOME/.corral}"; }

# urlencode "$1" — percent-encodes via jq's @uri, since the hook (unlike the MCP client) gets no
# encoding for free from a URL constructor.
urlencode() { jq -rn --arg v "$1" '$v|@uri'; }

# Emits "[corral] ctx {pct}% ({band})" on its own preconditions only: session_id present and
# well-formed, a statusline capture with a numeric ctx.pct, and a band above the lowest threshold.
# Returns 0 with empty stdout (never `exit`, which would also kill card_signal) when any
# precondition fails.
ctx_signal() {
  local block
  block="$(block_of ctx-signal)"
  [ -z "$block" ] && return 0

  local sid
  sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)"
  [ -z "$sid" ] && return 0
  case "$sid" in *[!A-Za-z0-9._-]*) return 0 ;; esac

  local pct
  pct="$(jq -r '.ctx.pct // empty' "$CONFIG_DIR/corral-status/$sid.json" 2>/dev/null || true)"
  [ -z "$pct" ] && return 0

  local thresholds_file thresholds t1 t2 t3 band
  thresholds_file="$(corral_home)/config.json"
  thresholds="$(jq -r '
    (.hooks.ctxThresholds // [30,40,60]) as $t
    | if ($t|type)=="array" and ($t|length)==3 and ($t|all(type=="number")) and ($t[0]<$t[1]) and ($t[1]<$t[2])
      then "\($t[0]) \($t[1]) \($t[2])"
      else "30 40 60" end
  ' "$thresholds_file" 2>/dev/null || echo "30 40 60")"
  # jq on an EMPTY file exits 0 with no output at all (not an error), so the `|| echo` above
  # never fires for that case specifically — this guard is what actually catches it.
  [ -z "$thresholds" ] && thresholds="30 40 60"
  # shellcheck disable=SC2086
  set -- $thresholds
  t1="$1"; t2="$2"; t3="$3"

  band="$(jq -n -r --argjson p "$pct" --argjson t1 "$t1" --argjson t2 "$t2" --argjson t3 "$t3" '
    if $p < $t1 then empty
    elif $p < $t2 then "notice"
    elif $p < $t3 then "nudge"
    else "urgent" end' 2>/dev/null || true)"
  [ -z "$band" ] && return 0

  printf '[corral] ctx %s%% (%s)' "$pct" "$band"
}

# Emits "[corral] card empty" on its own preconditions only, none shared with ctx_signal: the block
# is present; hooks.cardSignal is not explicitly `false`; HERDR_PANE_ID is set; curl exists; and
# GET /api/card-signal answers within 1s with a body whose .empty is true.
card_signal() {
  local block
  block="$(block_of card-signal)"
  [ -z "$block" ] && return 0

  local cardsig_flag
  cardsig_flag="$(jq -r '.hooks.cardSignal' "$(corral_home)/config.json" 2>/dev/null || true)"
  [ "$cardsig_flag" = "false" ] && return 0

  local pane_id
  pane_id="${HERDR_PANE_ID:-}"
  [ -z "$pane_id" ] && return 0

  command -v curl >/dev/null 2>&1 || return 0

  # Mirrors mcp/index.ts's BASE_URL whole: $CORRAL_URL when non-empty, else the loopback default
  # with <port> from $HERDR_DASH_PORT only when it is a non-empty run of digits, else 8787 — a shell
  # approximation of config.ts's intFromEnv, which also rejects a set-but-empty port.
  local port base
  port="${HERDR_DASH_PORT:-}"
  case "$port" in
    ''|*[!0-9]*) port=8787 ;;
  esac
  if [ -n "${CORRAL_URL:-}" ]; then
    base="$CORRAL_URL"
  else
    base="http://127.0.0.1:$port"
  fi

  # cwd is best-effort: nothing in this repo reads the hook input's .cwd field today, so its
  # presence is an unverified harness contract. Absent, the server's tie-break falls to socket alone.
  local cwd_val socket_val url
  cwd_val="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  socket_val="${HERDR_SOCKET_PATH:-}"

  url="$base/api/card-signal?paneId=$(urlencode "$pane_id")"
  [ -n "$cwd_val" ] && url="$url&cwd=$(urlencode "$cwd_val")"
  [ -n "$socket_val" ] && url="$url&socket=$(urlencode "$socket_val")"

  local body
  body="$(curl -fsS --connect-timeout 1 --max-time 1 "$url" 2>/dev/null || true)"
  [ -z "$body" ] && return 0

  local is_empty
  is_empty="$(printf '%s' "$body" | jq -r '.empty // empty' 2>/dev/null || true)"
  [ "$is_empty" = "true" ] || return 0

  printf '[corral] card empty'
}

case "$event" in
  SessionStart)
    ctx_block="$(block_of ctx-signal)"
    card_block="$(block_of card-signal)"
    joined=""
    for part in "$ctx_block" "$card_block"; do
      [ -z "$part" ] && continue
      if [ -z "$joined" ]; then joined="$part"; else joined="$joined"$'\n\n'"$part"; fi
    done
    [ -z "$joined" ] && exit 0
    emit "$joined"
    ;;
  UserPromptSubmit)
    # `|| true` is load-bearing: under `set -euo pipefail` with `trap 'exit 0' ERR`, an assignment
    # from a command substitution returning non-zero fires the trap and drops BOTH signals.
    ctx_line="$(ctx_signal || true)"
    card_line="$(card_signal || true)"
    joined=""
    for part in "$ctx_line" "$card_line"; do
      [ -z "$part" ] && continue
      if [ -z "$joined" ]; then joined="$part"; else joined="$joined"$'\n'"$part"; fi
    done
    [ -z "$joined" ] && exit 0
    emit "$joined"
    ;;
esac
