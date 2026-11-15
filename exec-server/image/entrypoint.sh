#!/usr/bin/env bash
set -Eeuo pipefail

# Only the optional Docker daemon needs root; both services run as agent.
if [[ $(id -u) == 0 ]]; then
  [[ ${START_DOCKER-false} != true ]] || docker-start
  exec setpriv --reuid=agent --regid=agent --init-groups \
    env HOME=/home/agent USER=agent LOGNAME=agent /usr/local/bin/entrypoint "$@"
fi
case "${START_DOCKER-false}" in
  true)
    docker info >/dev/null 2>&1 || {
      echo 'START_DOCKER=true requires --user root --privileged.' >&2
      exit 2
    } ;;
  false) ;;
  *) echo 'START_DOCKER must be true or false.' >&2; exit 2 ;;
esac

[[ ${1-} == serve ]] || exec opencode "$@"
: "${MODEL_API_KEY:?MODEL_API_KEY is required}"
OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("base64url"))')}"
export OPENCODE_PASSWORD
if [[ "$OPENCODE_PASSWORD" =~ [[:cntrl:]] ]]; then
  echo 'OPENCODE_PASSWORD must contain no control characters.' >&2
  exit 2
fi

mkdir -p -- "${WORKSPACE_ROOT:-/workspace/sawd}"
cd -- "${WORKSPACE_ROOT:-/workspace/sawd}"

# Tini forwards signals to this shared process group and reaps orphaned children.
# Stop the sibling service on failure; the container runtime bounds shutdown.
trap 'trap "" TERM INT; kill -TERM 0 2>/dev/null || true; wait || true' EXIT
trap 'trap "" TERM INT; trap - EXIT; wait || true; exit 143' TERM
trap 'trap "" TERM INT; trap - EXIT; wait || true; exit 130' INT

opencode "$@" &
opencode_pid=$!
opencode_url="${OPENCODE_URL:-http://127.0.0.1:3773}"
deadline=$((SECONDS + 90))
# The API discovers models at startup, so OpenCode must accept requests first.
until [[ $(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 1 \
  --user "opencode:$OPENCODE_PASSWORD" -- "${opencode_url%/}/api/info" || true) == 200 ]]; do
  if ! kill -0 "$opencode_pid" 2>/dev/null; then wait "$opencode_pid"; exit 1; fi
  if ((SECONDS >= deadline)); then echo 'OpenCode did not become ready within 90 seconds.' >&2; exit 1; fi
  sleep 0.25
done

# The task API also serves the UI and reporting MCP.
(
  cd -- "${APP_DIR:-/opt/sawd-exec-server}"
  export SAWD_PORT="${PORT:-3775}" SAWD_MCP_PORT="${MCP_PORT:-3776}" \
    SAWD_WORKSPACE_ROOT="${WORKSPACE_ROOT:-/workspace/sawd}" SAWD_START_DOCKER="${START_DOCKER:-false}"
  if [[ ${API_TOKEN+x} ]]; then export SAWD_API_TOKEN="$API_TOKEN"; fi
  exec node src/index.ts
) &
api_pid=$!

# Keep the container lifetime tied to both services (also works with macOS Bash).
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$opencode_pid" 2>/dev/null; do sleep 0.25; done
if ! kill -0 "$api_pid" 2>/dev/null; then wait "$api_pid"; else wait "$opencode_pid"; fi
