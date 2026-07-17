#!/usr/bin/env bash
#
# statusline-command.sh — a minimal Claude Code statusline that ALSO feeds corral.
#
# Claude Code pipes a JSON status blob to this script's STDIN on every statusline
# refresh; whatever the script prints to STDOUT becomes the line shown in the TUI.
# This script does two things:
#   1. renders a compact status line (model · dir · ctx% · cost), and
#   2. tees the SAME JSON to corral-status-capture.sh, which writes the metrics
#      file corral reads (model, context %, cost, 5h/7d rate-limit windows).
#
# Wire it up in <configDir>/settings.json:
#   { "statusLine": { "type": "command", "command": "<configDir>/statusline-command.sh" } }
#
# Already run your OWN statusline script? Do NOT use this one — keep yours and add
# only the single "corral inject" line below to it (right after it has read stdin
# into a variable and resolved its config dir).
#
# Requires: jq.

input="$(cat)"

# Which Claude config dir this session belongs to. The `claude` CLI exports
# CLAUDE_CONFIG_DIR for profile-split installs (e.g. the claude-work / claude-personal
# wrappers in the README); fall back to the default single-profile dir.
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# ── corral inject ─────────────────────────────────────────────────────────────
# The ONE line to copy into an existing statusline script. Non-blocking (&) and
# best-effort: it forwards the raw stdin JSON to the capture script and never
# delays or breaks the statusline.
printf '%s' "$input" | "$CONFIG_DIR/corral-status-capture.sh" "$CONFIG_DIR" >/dev/null 2>&1 &
# ──────────────────────────────────────────────────────────────────────────────

# ── visible statusline ────────────────────────────────────────────────────────
# jq drives both the inject (capture script) and this render. If it is missing,
# keep the line non-empty so the statusline doesn't look broken.
if ! command -v jq >/dev/null 2>&1; then
  printf 'claude'
  exit 0
fi

field() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

model="$(field '.model.display_name')"
dir="$(field '(.workspace.current_dir // .cwd)')"
pct="$(field '.context_window.used_percentage')"
cost="$(field '.cost.total_cost_usd')"

line=""
[ -n "$model" ] && line="$model"
[ -n "$dir" ]   && line="${line:+$line · }$(basename "$dir")"
[ -n "$pct" ]   && line="${line:+$line · }ctx ${pct}%"
[ -n "$cost" ]  && line="${line:+$line · }\$$(printf '%.2f' "$cost" 2>/dev/null || printf '%s' "$cost")"

printf '%s' "${line:-claude}"
