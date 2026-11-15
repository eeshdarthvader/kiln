#!/usr/bin/env bash
set -Eeuo pipefail

# Use the AWS SDK's standard credential and configuration chain.
exec /opt/aws-mcp/bin/mcp-proxy-for-aws-cli \
  "${AWS_GATEWAY_URL:?AWS_GATEWAY_URL is required}" \
  --service bedrock-agentcore --disable-telemetry
