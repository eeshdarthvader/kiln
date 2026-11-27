#!/usr/bin/env bash
# Sets Kiln up on this machine: checks the tools it needs, installs dependencies, creates the
# .env, builds the agent container and tells you how to start. Safe to run again; it never
# overwrites a value you already set.
#
#   scripts/setup.sh              interactive
#   scripts/setup.sh --yes        no prompts (also used when there is no terminal)
#   scripts/setup.sh --check      only check the tools, change nothing
#   scripts/setup.sh --skip-image do not build the agent container
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT/apps/control-plane/.env"
ENV_EXAMPLE="$ROOT/apps/control-plane/.env.example"
IMAGE=${FACTORY_AGENT_IMAGE:-localhost/factory-agent:latest}
SESSION=${HERDR_SESSION:-factory}

assume_yes=0 check_only=0 skip_image=0 rebuild=0
for arg in "$@"; do
  case $arg in
    --yes | -y) assume_yes=1 ;;
    --check) check_only=1 ;;
    --skip-image) skip_image=1 ;;
    --rebuild) rebuild=1 ;;
    -h | --help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done
[[ -t 0 ]] || assume_yes=1

if [[ -t 1 ]]; then bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' reset=$'\e[0m'
else bold='' dim='' red='' green='' yellow='' reset=''; fi
step() { printf '\n%s▸ %s%s\n' "$bold" "$1" "$reset"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$1"; }
fail() { printf '  %s✗%s %s\n' "$red" "$reset" "$1"; }

ask() { # ask "question" default(y|n) -> 0 for yes
  local reply
  ((assume_yes)) && { [[ $2 == y ]]; return; }
  read -r -p "  $1 [$([[ $2 == y ]] && echo Y/n || echo y/N)] " reply || reply=''
  reply=${reply:-$2}
  [[ $reply =~ ^[Yy] ]]
}

os=$(uname -s)
hint() { # hint "brew install x" "linux hint"
  if [[ $os == Darwin ]]; then printf '      %s%s%s\n' "$dim" "$1" "$reset"; else printf '      %s%s%s\n' "$dim" "$2" "$reset"; fi
}

# --- 1. Tools ---------------------------------------------------------------------------------
step "Checking tools"
missing=0
have() { command -v "$1" >/dev/null 2>&1; }

want_node=$(tr -d '[:space:]v' <"$ROOT/.nvmrc")
if have node; then
  have_node=$(node -p 'process.versions.node')
  if [[ ${have_node%%.*} == "${want_node%%.*}" ]]; then ok "Node $have_node"
  else fail "Node $have_node found, Kiln needs Node ${want_node%%.*} ($want_node)"; hint "brew install node@${want_node%%.*}   (or: nvm install $want_node)" "nvm install $want_node"; missing=1; fi
else fail "Node is not installed (need $want_node)"; hint "brew install node@${want_node%%.*}" "nvm install $want_node"; missing=1; fi

if have docker; then
  if docker info >/dev/null 2>&1; then ok "Docker is running"
  else fail "Docker is installed but not running"; hint "open -a Docker" "sudo systemctl start docker"; missing=1; fi
else fail "Docker is not installed"; hint "brew install --cask docker" "https://docs.docker.com/engine/install/"; missing=1; fi

if have python3; then ok "Python $(python3 -c 'import platform; print(platform.python_version())') (web terminal)"
else fail "python3 is not installed"; hint "brew install python" "sudo apt install python3"; missing=1; fi

if have gh; then
  if gh auth status >/dev/null 2>&1; then ok "gh is logged in"
  else fail "gh is installed but not logged in"; hint "gh auth login" "gh auth login"; missing=1; fi
else fail "gh (GitHub CLI) is not installed"; hint "brew install gh" "https://cli.github.com"; missing=1; fi

if have herdr; then ok "Herdr $(herdr --version 2>/dev/null | head -n1)"
else fail "Herdr is not installed (needs 0.9.5 or later)"; hint "see https://herdr.dev" "see https://herdr.dev"; missing=1; fi

have make && ok "make" || { fail "make is not installed"; hint "xcode-select --install" "sudo apt install make"; missing=1; }
have git && ok "git" || { fail "git is not installed"; missing=1; }

if ((missing)); then
  printf '\n%sInstall what is missing above, then run this again.%s\n' "$red" "$reset" >&2
  exit 1
fi
((check_only)) && { printf '\n%sAll tools are present.%s\n' "$green" "$reset"; exit 0; }

# --- 2. Dependencies --------------------------------------------------------------------------
step "Installing dependencies"
cd "$ROOT"
if [[ -d node_modules ]]; then npm install --no-audit --no-fund >/dev/null; else npm ci --no-audit --no-fund >/dev/null; fi
ok "npm packages installed"

# --- 3. .env ----------------------------------------------------------------------------------
step "Configuration ($ENV_FILE)"
if [[ -f $ENV_FILE ]]; then ok ".env exists; keeping your values"
else cp "$ENV_EXAMPLE" "$ENV_FILE"; chmod 600 "$ENV_FILE"; ok "created .env from .env.example"; fi

env_value() { # the value a key already has in .env (uncommented), or empty
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}
set_env() { # set_env KEY VALUE: replace the key (commented or not) or append it
  KEY=$1 VALUE=$2 FILE=$ENV_FILE python3 -I - <<'PY'
import os, re
key, value, path = os.environ["KEY"], os.environ["VALUE"], os.environ["FILE"]
lines = open(path).read().splitlines()
pattern = re.compile(r"^#?\s*" + re.escape(key) + r"=")
for i, line in enumerate(lines):
    if pattern.match(line):
        lines[i] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")
open(path, "w").write("\n".join(lines) + "\n")
PY
}

if [[ -z $(env_value FACTORY_REPOS) ]]; then
  repos=${FACTORY_REPOS:-}
  if [[ -z $repos ]] && ! ((assume_yes)); then
    guess=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
    read -r -p "  Repositories to watch, owner/name, comma separated [${guess:-none}]: " repos || repos=''
    repos=${repos:-$guess}
  fi
  if [[ -n $repos ]]; then set_env FACTORY_REPOS "$repos"; ok "watching $repos"
  else warn "FACTORY_REPOS is empty: add issues from the dashboard, or set it in .env later"; fi
else ok "FACTORY_REPOS = $(env_value FACTORY_REPOS)"; fi

if [[ -n $(env_value CLAUDE_CODE_OAUTH_TOKEN) || -n $(env_value ANTHROPIC_API_KEY) || -n ${CLAUDE_CODE_OAUTH_TOKEN:-} || -n ${ANTHROPIC_API_KEY:-} ]]; then
  ok "Claude credential found"
else
  warn "No Claude credential yet. Agents need one: run \`claude setup-token\`, or use an API key."
  if ! ((assume_yes)); then
    read -r -s -p "  Paste CLAUDE_CODE_OAUTH_TOKEN (input hidden, Enter to skip): " token || token=''
    echo
    if [[ -n $token ]]; then set_env CLAUDE_CODE_OAUTH_TOKEN "$token"; ok "saved to .env (owner-readable only)"
    else warn "skipped: add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env before starting"; fi
  fi
fi

if [[ $os == Linux ]]; then
  [[ -n $(env_value FACTORY_AGENT_DOCKER_ARGS) ]] || set_env FACTORY_AGENT_DOCKER_ARGS "--add-host=host.docker.internal:host-gateway"
  [[ -n $(env_value FACTORY_MCP_HOST) ]] || set_env FACTORY_MCP_HOST "0.0.0.0"
  ok "Linux: containers can reach the host through host.docker.internal"
fi

# --- 4. Agent container -----------------------------------------------------------------------
step "Agent container"
if ((skip_image)); then warn "skipped (--skip-image): build it later with \`make -C apps/runtime agent-image\`"
elif docker image inspect "$IMAGE" >/dev/null 2>&1 && ! ((rebuild)); then ok "$IMAGE already built (use --rebuild to rebuild)"
elif ask "Build $IMAGE now? It downloads tools and takes a few minutes." y; then
  make -C "$ROOT/apps/runtime" agent-image IMAGE="$IMAGE"
  ok "built $IMAGE"
else warn "skipped: build it later with \`make -C apps/runtime agent-image\`"; fi

# --- 5. Next steps ----------------------------------------------------------------------------
step "Ready"
cat <<EOF
  Start it in two terminals:

    ${bold}herdr --session $SESSION server${reset}     ${dim}# the terminal layer the agents run in${reset}
    ${bold}npm run dev${reset}                          ${dim}# the control plane, from $ROOT${reset}

  Then open ${bold}http://127.0.0.1:3775${reset}, label an issue \`factory\` in a watched repository,
  or use ${bold}Add issue${reset} in the dashboard. Watch the agents with ${bold}herdr --session $SESSION${reset}.
EOF
