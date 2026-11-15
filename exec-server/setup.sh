#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

readonly REGISTRY=123456789012.dkr.ecr.eu-central-1.amazonaws.com
readonly IMAGE="${IMAGE:-$REGISTRY/software-factory-execution-server:v0.3}"
readonly CONTAINER="${CONTAINER:-software-factory-exec-server}"

setup_step=0
setup_stage='Validate setup options'
log() {
  local label=$1 color='' reset=''
  shift
  if [[ -t 1 && ${TERM:-dumb} != dumb && -z ${NO_COLOR:-} ]]; then
    reset=$'\033[0m'
    case "$label" in
      OK) color=$'\033[32m' ;;
      SKIP|WAIT) color=$'\033[33m' ;;
      FAIL) color=$'\033[31m' ;;
      *) color=$'\033[1;36m' ;;
    esac
  fi
  [[ $label != OK ]] || label='OK  '
  printf '  %s[%s]%s %s\n' "$color" "$label" "$reset" "$*"
}
step() {
  setup_step=$((setup_step + 1))
  setup_stage=$*
  printf '\n'
  log "$setup_step/7" "$setup_stage"
}
fail() { log FAIL "$setup_stage: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null || fail "Install $1, then rerun setup."; }
env_temp=''
finish() {
  local exit_status=$? color='' reset=''
  trap - ERR
  [[ -z $env_temp ]] || rm -f -- "$env_temp" || :
  if [[ -t 2 && ${TERM:-dumb} != dumb && -z ${NO_COLOR:-} ]]; then
    color=$'\033[1;31m'
    reset=$'\033[0m'
  fi
  printf '\n%s  WARNING: Setup stores credentials in .env and the Docker container configuration.\n  Do not commit or share .env, the container, or docker inspect output.%s\n' \
    "$color" "$reset" >&2
  exit "$exit_status"
}
trap finish EXIT
# Report the active stage without echoing commands that may contain credentials.
trap 'fail "Command failed (exit $?). Resolve the error above, then rerun setup."' ERR

if [[ ${1-} == --help ]]; then
  cat <<'HELP'
Usage: bash setup.sh

Run from the directory that should hold .env and workspace/.
Requires Docker, GitHub CLI (gh auth login), and AWS CLI with ECR pull access.
Set AWS_PROFILE to a configured AWS profile when the image must be pulled.
IMAGE and CONTAINER can override the published image and container name.
The default container name is software-factory-exec-server.
Reruns reuse credentials and matching containers; changed configurations are recreated.
GPR_TOKEN is read from your environment, then .env, then gh auth token.
Requires read:packages; missing scope stops setup with manual remediation.
Container replacement keeps .env and workspace, but removes container-local sessions.
Copies ~/.m2/settings.xml and ~/.gradle/gradle.properties, when present, into
/home/agent on every run, owned by agent.
Sets OPENCODE_PASSWORD=tester and disables the AWS MCP Gateway.
Credentials are saved to .env. Remove .env and the container after testing.
Progress includes numbered steps and skip reasons. Set NO_COLOR=1 to disable color.
On success, prints UI and OpenCode access, Atlassian MCP OAuth steps, shutdown,
and full reset commands for this setup.
HELP
  exit 0
fi
[[ $# == 0 ]] || fail 'Unexpected arguments. Use --help for usage.'
[[ $IMAGE == "$REGISTRY/"* && $IMAGE != *[[:space:]]* ]] || fail "IMAGE must reference $REGISTRY."
[[ $CONTAINER =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'Invalid CONTAINER name.'
printf '\nsoftware-factory execution server setup\n'
step 'Check Docker'
log INFO 'Checking Docker CLI and daemon...'
require_command docker
docker info >/dev/null 2>&1 || fail 'Start Docker Desktop or Docker Engine, then rerun setup.'
log OK 'Docker is available.'

step 'Prepare local files'
readonly SETUP_DIR="$(pwd -P)"
readonly ENV_FILE="$SETUP_DIR/.env"
readonly WORKSPACE="$SETUP_DIR/workspace"
# Docker's --mount syntax treats commas as field separators.
[[ $WORKSPACE != *[,\"$'\n\r']* ]] || fail 'Run setup from a path without commas, quotes, or line breaks.'
[[ ! -L $ENV_FILE && (! -e $ENV_FILE || -f $ENV_FILE) ]] || fail '.env must be a regular file, not a symlink.'
[[ ! -L $WORKSPACE && (! -e $WORKSPACE || -d $WORKSPACE) ]] || fail 'workspace must be a directory, not a symlink.'
if [[ -e $ENV_FILE ]]; then
  log SKIP '.env already exists; keeping saved settings.'
else
  : > "$ENV_FILE"
  log OK 'Created .env.'
fi
chmod 600 "$ENV_FILE"
log OK '.env permissions restricted to your user (600).'
log INFO "Credentials are saved to .env ($ENV_FILE). Remove .env and the container after testing."
if [[ -d $WORKSPACE ]]; then
  log SKIP "Workspace already exists: $WORKSPACE"
else
  (umask 022; mkdir -p "$WORKSPACE")
  log OK "Created workspace: $WORKSPACE"
fi

# Docker env files are data, not shell scripts. Last assignment wins.
env_value() {
  local line value=''
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line == "$1="* ]]; then value=${line#*=}; fi
  done < "$ENV_FILE"
  printf '%s' "$value"
}

save_secret() {
  local key=$1 value=$2 line
  [[ -n $value && $value != *[[:space:][:cntrl:]]* ]] || fail "$key must be a nonempty token without whitespace."
  env_temp=$(mktemp "$SETUP_DIR/.env.XXXXXX")
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "$key="* ]] || printf '%s\n' "$line" >> "$env_temp"
  done < "$ENV_FILE"
  printf '%s=%s\n' "$key" "$value" >> "$env_temp"
  mv -- "$env_temp" "$ENV_FILE"
  env_temp=''
}

step 'Configure credentials'
if [[ -z $(env_value MODEL_API_KEY) ]]; then
  log INFO 'Get a Bifrost key at https://ai-gateway.example.com/workspace/governance/virtual-keys'
  log INFO 'Bifrost key is missing; enter it below (input is hidden).'
  IFS= read -r -s -p '  Bifrost API key: ' bifrost_key || fail 'Could not read the Bifrost key. Run bash setup.sh interactively.'
  printf '\n'
  save_secret MODEL_API_KEY "$bifrost_key"
  unset bifrost_key
  log OK 'Saved Bifrost key.'
else
  log SKIP 'Using saved Bifrost key; no input needed.'
fi
if [[ -z $(env_value GH_TOKEN) ]]; then
  log INFO 'Reading GitHub token from gh auth...'
  require_command gh
  github_token=$(gh auth token) || fail 'Run gh auth login, then rerun setup.'
  save_secret GH_TOKEN "$github_token"
  unset github_token
  log OK 'Saved GitHub token.'
else
  log SKIP 'Using saved GitHub token; GitHub CLI lookup not needed.'
fi

package_token="${GPR_TOKEN:-$(env_value GPR_TOKEN)}"
if [[ -z $package_token ]]; then
  log INFO 'Reading GitHub Packages token from gh auth...'
  require_command gh
  package_token=$(gh auth token --hostname github.com 2>/dev/null) || fail 'Run gh auth login --hostname github.com or export GPR_TOKEN, then rerun setup.'
fi
[[ -n $package_token && $package_token != *[[:space:][:cntrl:]]* ]] || fail 'GPR_TOKEN must be a nonempty token without whitespace.'

log INFO 'Checking GitHub Packages token scope...'
require_command gh
package_token_help='For gh-managed credentials, unset GH_TOKEN and GITHUB_TOKEN, then run gh auth refresh --hostname github.com --scopes read:packages manually. Remove any stale GPR_TOKEN from .env and your environment before rerunning setup. For a custom token, update its permissions or export a replacement GPR_TOKEN.'
package_scopes=$(GH_TOKEN="$package_token" GH_DEBUG= gh api --hostname github.com --include --silent user 2>/dev/null |
  awk 'tolower($1) == "x-oauth-scopes:" {sub(/^[^:]*:/, ""); gsub(/[[:space:]]/, ""); print}') ||
  fail "Could not verify GPR_TOKEN scopes. $package_token_help"
case ",$package_scopes," in
  *,read:packages,*|*,write:packages,*) ;;
  *) fail "GPR_TOKEN needs a verifiable read:packages scope. $package_token_help" ;;
esac
unset package_scopes package_token_help
save_secret GPR_TOKEN "$package_token"
log OK 'Saved GitHub Packages token with package read scope.'

save_secret OPENCODE_PASSWORD tester
log OK 'OpenCode test password saved; AWS MCP Gateway will be disabled.'

step 'Check container and image'
log INFO "Checking for container $CONTAINER..."
# Replacement is limited to the selected container name.
containers=$(docker container ls -a --format '{{.Names}}')
container_exists=false
replace_container=false
while IFS= read -r name; do
  if [[ $name == "$CONTAINER" ]]; then container_exists=true; fi
done <<< "$containers"
if $container_exists; then
  existing_workspace=$(docker inspect --format '{{index .Config.Labels "software-factory.workspace"}}' "$CONTAINER")
  existing_image=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")
  existing_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER")
  # Compare explicit .env assignments and Docker overrides without exposing values.
  if [[ $existing_workspace != "$WORKSPACE" || $existing_image != "$IMAGE" ]] ||
    ! printf '%s\n' "$existing_env" | awk '
    FILENAME != "-" {
      sub(/\r$/, "")
      if ($0 ~ /^[[:space:]]*(#|$)/ || !index($0, "=")) next
      expected[substr($0, 1, index($0, "=") - 1)] = substr($0, index($0, "=") + 1)
      next
    }
    { actual[substr($0, 1, index($0, "=") - 1)] = substr($0, index($0, "=") + 1) }
    END {
      expected["START_DOCKER"] = "true"
      expected["PORT"] = "3775"
      expected["MCP_PORT"] = "3776"
      expected["WORKSPACE_ROOT"] = "/workspace/software-factory"
      expected["AWS_GATEWAY_URL"] = ""
      for (key in expected)
        if (!(key in actual) || actual[key] != expected[key]) exit 1
    }' "$ENV_FILE" -; then
    replace_container=true
    log INFO 'Container configuration changed; it will be replaced after the image check.'
  else
    log OK 'Existing container matches this setup.'
    log SKIP 'ECR login and image pull not needed; reusing the existing container.'
  fi
  unset existing_env
fi
if ! $container_exists || $replace_container; then
  log INFO "Checking local image: $IMAGE"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    [[ -n ${AWS_PROFILE:-} ]] || fail 'AWS_PROFILE is required to pull the image. Set it with export AWS_PROFILE=your-profile, then rerun setup.'
    log INFO "Image is missing locally; logging into ECR ($REGISTRY)..."
    require_command aws
    aws ecr get-login-password --region eu-central-1 |
      docker login --username AWS --password-stdin "$REGISTRY"
    log OK 'Logged into ECR.'
    log INFO "Pulling image: $IMAGE"
    docker pull "$IMAGE"
    log OK 'Image is available locally.'
  else
    log SKIP 'ECR login and image pull not needed; using the local image.'
  fi
fi
unset package_token

step 'Start container'
if $replace_container; then
  log INFO "Stopping and removing $CONTAINER; .env and workspace are kept, container-local sessions are removed."
  docker stop "$CONTAINER" >/dev/null
  docker rm "$CONTAINER" >/dev/null
  container_exists=false
  log OK 'Removed container with outdated configuration.'
fi
if $container_exists; then
  log SKIP 'Workspace permissions and container creation not needed; reusing the existing container.'
  state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER")
  case "$state" in
    running) log SKIP "Container $CONTAINER is already running; start not needed." ;;
    created|exited)
      log INFO "Starting existing container $CONTAINER..."
      docker start "$CONTAINER" >/dev/null
      log OK 'Container started.' ;;
    *) fail "Container $CONTAINER is $state. Resolve its state, then rerun setup." ;;
  esac
else
  # Linux bind mounts retain host ownership. Repair only the workspace directory,
  # and only when the image's runtime user cannot write to it; never recurse.
  log INFO 'Checking workspace write permissions for the runtime user...'
  docker run --rm --user root --entrypoint /bin/sh \
    --mount "type=bind,source=$WORKSPACE,target=/workspace/software-factory" "$IMAGE" -c '
      if ! setpriv --reuid=agent --regid=agent --init-groups test -w /workspace/software-factory; then
        chown 1000:1000 /workspace/software-factory && chmod u+rwx /workspace/software-factory || exit 1
        printf "  [OK  ] Updated workspace directory permissions.\n"
      else
        printf "  [SKIP] Workspace permissions already allow the runtime user to write.\n"
      fi'
  log OK 'Workspace permission check completed.'
  log INFO "Creating and starting container $CONTAINER..."
  docker run -d --name "$CONTAINER" --env-file "$ENV_FILE" \
    --label "software-factory.workspace=$WORKSPACE" \
    --mount "type=bind,source=$WORKSPACE,target=/workspace/software-factory" \
    -p 127.0.0.1:3773:3773 -p 127.0.0.1:3775:3775 \
    --privileged --user root -e START_DOCKER=true \
    -e PORT=3775 -e MCP_PORT=3776 -e WORKSPACE_ROOT=/workspace/software-factory -e AWS_GATEWAY_URL= \
    --health-cmd 'curl --fail --silent --max-time 2 http://127.0.0.1:3775/readyz >/dev/null' \
    "$IMAGE" >/dev/null
  log OK 'Container created and started.'
fi

step 'Copy Maven and Gradle settings'
for config_path in .m2/settings.xml .gradle/gradle.properties; do
  source_file="$HOME/$config_path"
  if [[ -f $source_file ]]; then
    # The entrypoint drops to agent for services and their build commands.
    destination_file="/home/agent/$config_path"
    log INFO "Copying $source_file to $CONTAINER:$destination_file..."
    docker exec --user agent "$CONTAINER" mkdir -p "/home/agent/${config_path%/*}"
    docker cp "$source_file" "$CONTAINER:$destination_file"
    docker exec --user root "$CONTAINER" chown agent:agent "$destination_file"
    docker exec --user root "$CONTAINER" chmod 600 "$destination_file"
    log OK "Copied $config_path for agent (permissions 600)."
  else
    log SKIP "$source_file does not exist as a regular file; skipping."
  fi
done

step 'Wait for readiness'
log INFO 'Waiting for the task UI (up to 240 seconds)...'
readiness_started=$SECONDS
deadline=$((readiness_started + 240))
next_progress=$readiness_started
while ((SECONDS < deadline)); do
  status=$(docker inspect --format '{{.State.Status}}' "$CONTAINER")
  [[ $status == running ]] || fail "Container $CONTAINER is $status. Inspect it with: docker logs $CONTAINER"
  # Docker's cached health status can lag readiness by a full healthcheck interval.
  if docker exec "$CONTAINER" curl --fail --silent --max-time 2 \
    http://127.0.0.1:3775/readyz >/dev/null 2>&1; then
    log OK "Task UI is healthy after $((SECONDS - readiness_started)) seconds."
    printf '\nSetup complete\n'
    printf '  Task UI:  http://127.0.0.1:3775\n'
    printf '  OpenCode: http://127.0.0.1:3773\n'
    printf '  Username: opencode\n'
    printf '  Password: tester\n'
    printf '  Workspace: %s\n  Container: %s\n' "$WORKSPACE" "$CONTAINER"
    printf '\nAtlassian MCP access (run on your host, outside the container):\n'
    printf '```sh\n'
    printf '  codex mcp add mcp_catalog --url https://ai-gateway.example.com/mcp  # if not done already\n'
    printf '  codex mcp login mcp_catalog\n'
    printf '```\n'
    printf '\nStop:\n```sh\n  docker stop %q\n```\n' "$CONTAINER"
    printf '\nFull reset (run from %s): removes container state, sessions, and workspace while keeping .env.\n' "$SETUP_DIR"
    printf '```sh\n'
    printf '  docker stop %q && docker rm %q && rm -rf -- %q\n' \
      "$CONTAINER" "$CONTAINER" "$WORKSPACE"
    printf '```\n'
    exit 0
  fi
  if ((SECONDS >= next_progress)); then
    log WAIT "Container is running; task UI is starting ($((SECONDS - readiness_started))/240 seconds elapsed)."
    next_progress=$((SECONDS + 10))
  fi
  sleep 2
done
fail "Readiness timed out after 240 seconds. Inspect it with: docker logs $CONTAINER"
