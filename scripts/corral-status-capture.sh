#!/usr/bin/env bash
# corral-status-capture.sh <config_dir>
# Reads Claude Code's statusline JSON on stdin, maps it to Corral status schema v1, and atomically
# writes <config_dir>/corral-status/<session_id>.json. Best-effort: any failure exits 0 so it can
# never disturb the statusline that backgrounds it.
set -euo pipefail
# Belt-and-braces for the "best-effort" contract above: guarded steps already fall back via `||`,
# but an unguarded failure (e.g. mkdir/mv hitting a permissions or disk-full error) would otherwise
# propagate a non-zero exit under `set -e`. Force exit 0 in that case too.
trap 'exit 0' ERR
CONFIG_DIR="${1:-$HOME/.claude}"
input="$(cat)"

sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)"
[ -z "$sid" ] && exit 0
case "$sid" in *[!A-Za-z0-9._-]*) exit 0 ;; esac

# The oauthAccount lives at $CONFIG_DIR/.claude.json for a profile-split install (CLAUDE_CONFIG_DIR
# → nested .claude.json), but at $HOME/.claude.json for a default single-profile install (e.g. the
# remote boxes). Prefer the nested one; fall back to the home one so remote accounts resolve too.
acct_file="$CONFIG_DIR/.claude.json"
[ -f "$acct_file" ] || acct_file="$HOME/.claude.json"
acct="$(jq -c '.oauthAccount | {uuid:.accountUuid, email:.emailAddress, org:.organizationName, tier:.organizationRateLimitTier}' \
          "$acct_file" 2>/dev/null || echo null)"

out="$(printf '%s' "$input" | jq -c --argjson acct "$acct" --argjson ts "$(date +%s)" '{
  v: 1, captured_at: $ts,
  session_id: .session_id, session_name: (.session_name // null),
  account: $acct,
  model: (.model.display_name // null), model_id: (.model.id // null),
  ctx: { pct: (.context_window.used_percentage // null),
         tokens: (.context_window.total_input_tokens // null),
         window: (.context_window.context_window_size // null) },
  cost: { usd: (.cost.total_cost_usd // null),
          lines_added: (.cost.total_lines_added // null),
          lines_removed: (.cost.total_lines_removed // null) },
  rate: { five_hour: (.rate_limits.five_hour // null),
          seven_day: (.rate_limits.seven_day // null) },
  effort: (.effort.level // null), thinking: (.thinking.enabled // null),
  cc_version: (.version // null)
}' 2>/dev/null || true)"
[ -z "$out" ] && exit 0

dir="$CONFIG_DIR/corral-status"
mkdir -p "$dir" || exit 0
tmp="$dir/.$sid.$$.tmp"
# Each write step is its own statement guarded with `|| exit 0` (not chained with `&&`): a non-final
# element of an `&&` list is exempt from both `set -e` and the ERR trap, so a failed redirect (e.g.
# ENOSPC/disk-full on the `printf`) would otherwise leak a non-zero exit. On any failure remove the
# tmp so a partial/dead file is never left behind, then exit 0 per the best-effort contract.
printf '%s' "$out" > "$tmp" || { rm -f "$tmp"; exit 0; }
mv -f "$tmp" "$dir/$sid.json" || { rm -f "$tmp"; exit 0; }
