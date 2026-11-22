#!/usr/bin/env bash
set -Eeuo pipefail

client="${0##*/}"

case "$client" in
  gh|git) ;;
  *)
    echo "Unsupported GitHub client wrapper: $client" >&2
    exit 1
    ;;
esac

if [[ -z "${GITHUB_EGRESS_PROXY:-}" ]]; then
  exec "/usr/bin/$client" "$@"
fi
proxy_url="$GITHUB_EGRESS_PROXY"

export HTTP_PROXY="$proxy_url" HTTPS_PROXY="$proxy_url" ALL_PROXY="$proxy_url"
export http_proxy="$proxy_url" https_proxy="$proxy_url" all_proxy="$proxy_url"
export NO_PROXY= no_proxy=
unset GIT_SSL_NO_VERIFY

if [[ "$client" == "gh" ]]; then
  export GH_TOKEN=proxy-placeholder
fi

git_config=(
  "http.proxy=$proxy_url"
  "http.sslVerify=true"
  "url.https://github.com/.insteadOf=git@github.com:"
  "url.https://github.com/.insteadOf=ssh://git@github.com/"
)

ca_file="${GITHUB_EGRESS_CA:-/usr/local/share/ca-certificates/github-egress-proxy.crt}"
if [[ "$ca_file" != /* ]]; then
  ca_file="$PWD/$ca_file"
fi
if [[ ! -f "$ca_file" || ! -r "$ca_file" ]]; then
  echo "GITHUB_EGRESS_CA must name a readable CA file." >&2
  exit 1
fi
export SSL_CERT_FILE="$ca_file" GIT_SSL_CAINFO="$ca_file"
git_config+=("http.sslCAInfo=$ca_file")

config_count="${GIT_CONFIG_COUNT:-0}"
if [[ ! "$config_count" =~ ^[0-9]{1,6}$ ]]; then
  echo "GIT_CONFIG_COUNT must be an integer between 0 and 999999." >&2
  exit 2
fi
config_count=$((10#$config_count))
for entry in "${git_config[@]}"; do
  export "GIT_CONFIG_KEY_$config_count=${entry%%=*}"
  export "GIT_CONFIG_VALUE_$config_count=${entry#*=}"
  config_count=$((config_count + 1))
done
export GIT_CONFIG_COUNT="$config_count"

exec "/usr/bin/$client" "$@"
