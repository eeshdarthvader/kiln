#!/usr/bin/env bash
# Runs one factory stage: starts Claude Code with the stage prompt and the factory's
# reporting MCP server. The factory supplies everything through FACTORY_* variables.
set -Eeuo pipefail

: "${FACTORY_STAGE:?FACTORY_STAGE is required}"
: "${FACTORY_MCP_URL:?FACTORY_MCP_URL is required}"
: "${FACTORY_PROMPT_FILE:?FACTORY_PROMPT_FILE is required}"
[[ -r $FACTORY_PROMPT_FILE ]] || { echo "Cannot read $FACTORY_PROMPT_FILE." >&2; exit 2; }
if [[ -z ${CLAUDE_CODE_OAUTH_TOKEN-} && -z ${ANTHROPIC_API_KEY-} ]]; then
  echo 'Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY for the factory server.' >&2
  exit 2
fi

git config --global user.name "${FACTORY_GIT_NAME:-Software Factory}"
git config --global user.email "${FACTORY_GIT_EMAIL:-software-factory@users.noreply.github.com}"

config_dir=$(mktemp -d)
jq -n --arg url "$FACTORY_MCP_URL" '{mcpServers: {factory: {type: "http", url: $url}}}' \
  > "$config_dir/mcp.json"

args=(--dangerously-skip-permissions --mcp-config "$config_dir/mcp.json" --strict-mcp-config)
[[ -z ${FACTORY_AGENT_MODEL-} ]] || args+=(--model "$FACTORY_AGENT_MODEL")
prompt=$(<"$FACTORY_PROMPT_FILE")

case "${FACTORY_AGENT_MODE:-interactive}" in
  print)
    # Headless: no terminal UI; the process exits when the stage's turn ends.
    exec claude --print "${args[@]}" -- "$prompt" ;;
  interactive)
    # Answer the first-run screens ahead of time: nobody is at this terminal.
    jq -n --arg dir "$PWD" '{
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: {($dir): {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}}
    }' > "$HOME/.claude.json"
    exec claude "${args[@]}" -- "$prompt" ;;
  *) echo 'FACTORY_AGENT_MODE must be interactive or print.' >&2; exit 2 ;;
esac
