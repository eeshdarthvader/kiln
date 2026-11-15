#!/usr/bin/env bash
set -Eeuo pipefail

# Keep gateway credentials in the process environment, never in configuration files.
# The OpenAI SDK retains the Responses API used by the AI gateway.
model="${OPENCODE_MODEL:-gpt-6-luna}"
context_limit="${OPENCODE_CONTEXT_LIMIT:-128000}"
output_limit="${OPENCODE_OUTPUT_LIMIT:-16384}"
for limit in "$context_limit" "$output_limit"; do
  if [[ ! "$limit" =~ ^[1-9][0-9]{0,8}$ ]]; then
    echo 'OPENCODE_CONTEXT_LIMIT and OPENCODE_OUTPUT_LIMIT must be positive integers below 1000000000.' >&2
    exit 2
  fi
done
if ((output_limit >= context_limit)); then
  echo 'OPENCODE_OUTPUT_LIMIT must be smaller than OPENCODE_CONTEXT_LIMIT.' >&2
  exit 2
fi
config="$(jq -nc --arg model "$model" --arg models "${OPENCODE_MODELS:-gpt-6-luna,gpt-6-sol,gpt-6-astra}" \
  --arg port "${MCP_PORT:-3776}" --argjson context "$context_limit" --argjson output "$output_limit" '
  {
    "$schema": "https://opencode.ai/config.json",
    autoupdate: false,
    plugins: ["/opt/superpowers"],
    share: "disabled",
    enabled_providers: ["gateway"],
    model: ("gateway/" + $model),
    small_model: ("gateway/" + $model),
    provider: {gateway: {
      name: "AI Gateway",
      npm: "@ai-sdk/openai",
      env: ["MODEL_API_KEY"],
      options: {baseURL: "https://ai-gateway.example.com/openai/v1", apiKey: "{env:MODEL_API_KEY}"},
      models: (($models | split(",")) + [$model] | unique | map(select(length > 0)) |
        map({key: ., value: {name: ., tool_call: true, limit: {context: $context, output: $output}}}) | from_entries)
    }},
    mcp: {
      "sawd-execution": {type: "remote", url: ("http://127.0.0.1:" + $port + "/mcp"), oauth: false},
      "mcp_catalog": {
        type: "remote", url: "https://ai-gateway.example.com/mcp", oauth: false,
        headers: {"x-bf-vk": "{env:MODEL_API_KEY}"}
      }
    }
  }')"

if [[ -n "${AWS_GATEWAY_URL:-}" ]]; then
  config="$(jq -c '.mcp["aws-gateway"] = {
    type: "local",
    command: ["/usr/local/bin/aws-mcp"],
    timeout: 60000
  }' <<<"$config")"
fi

export OPENCODE_CONFIG_CONTENT="$config"
exec /opt/opencode/opencode "$@"
