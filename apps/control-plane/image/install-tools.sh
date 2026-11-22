#!/bin/sh
# Build-time mise and Node/npm bootstrap, run as root.
set -eu

download_artifact() {
    artifact_url=$(printf '%s' "$1" | jq -er '.url | select(startswith("https://"))')
    artifact_checksum=$(printf '%s' "$1" | jq -er '.sha256 | select(test("^[a-f0-9]{64}$"))')
    echo "Downloading ${artifact_url}" >&2
    curl --fail --location --silent --show-error --retry 3 \
        --connect-timeout 30 --max-time 900 --proto '=https' --proto-redir '=https' \
        "$artifact_url" -o "$2"
    printf '%s  %s\n' "$artifact_checksum" "$2" | sha256sum --check --status || {
        echo "SHA-256 verification failed: ${artifact_url}" >&2
        return 1
    }
}

manifest="${MISE_DATA_DIR:?MISE_DATA_DIR must be set}/tool-versions.json"
architecture=$(dpkg --print-architecture)
config="${MISE_CONFIG_DIR:?MISE_CONFIG_DIR must be set}/config.toml"
node_version=$(jq -er '.node.version' "$manifest")
# Block metadata requests and implicit installs during registration as well.
export MISE_OFFLINE=true MISE_AUTO_INSTALL=false

download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT
download_artifact "$(jq -ce --arg arch "$architecture" \
    '.mise.downloads[$arch] // error("Unsupported architecture: " + $arch)' "$manifest")" "${download_dir}/mise.tar.gz"
download_artifact "$(jq -ce --arg arch "$architecture" \
    '.node.downloads[$arch] // error("Unsupported architecture: " + $arch)' "$manifest")" "${download_dir}/node.tar.gz"
download_artifact "$(jq -ce '.npm.download' "$manifest")" "${download_dir}/npm.tar.gz"

tar -xzf "${download_dir}/mise.tar.gz" -C "$download_dir" mise/bin/mise
install -m 0755 "${download_dir}/mise/bin/mise" /usr/local/bin/mise
destination="${MISE_DATA_DIR}/toolsets/node/${node_version}"
mkdir -p "$destination"
tar -xzf "${download_dir}/node.tar.gz" --strip-components=1 -C "$destination"
# Replace bundled npm, including its dependencies, with the pinned patched release.
rm -rf "${destination}/lib/node_modules/npm"
mkdir -p "${destination}/lib/node_modules/npm"
tar -xzf "${download_dir}/npm.tar.gz" --strip-components=1 -C "${destination}/lib/node_modules/npm"
mise link "node@${node_version}" "$destination"

# Write the default directly without resolving a version catalogue.
printf '\n[tools]\n' >> "$config"
jq -r '.node.version | "node = \(tojson)"' "$manifest" >> "$config"
mise reshim
