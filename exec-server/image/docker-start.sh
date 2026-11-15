#!/usr/bin/env bash
set -Eeuo pipefail

readonly DOCKER_READY_TIMEOUT_SECONDS=30
readonly DOCKER_LOG_DIR=/var/log/docker
readonly DOCKER_LOG_FILE="${DOCKER_LOG_DIR}/dockerd.log"
readonly DOCKER_START_LOCK="${DOCKER_LOG_DIR}/start.lock"

is_docker_ready() {
    docker info >/dev/null 2>&1
}

if is_docker_ready; then
    exit 0
fi

mkdir -p "$DOCKER_LOG_DIR"
exec 9>"$DOCKER_START_LOCK"
flock --exclusive 9

# Another caller may have started Docker while this process waited for the lock.
if is_docker_ready; then
    exit 0
fi

# Detach the daemon's I/O from the caller and close the lock descriptor so the
# terminal remains usable and the lock is released when this script exits.
# vfs avoids unsupported nested overlayfs mounts in the container runtime.
nohup dockerd --storage-driver=vfs \
    </dev/null >"$DOCKER_LOG_FILE" 2>&1 9>&- &
dockerd_pid=$!
deadline=$((SECONDS + DOCKER_READY_TIMEOUT_SECONDS))

while ((SECONDS < deadline)); do
    if is_docker_ready; then
        exit 0
    fi

    if ! kill -0 "$dockerd_pid" 2>/dev/null; then
        wait "$dockerd_pid" || status=$?
        echo "Docker daemon failed to start" >&2
        cat "$DOCKER_LOG_FILE" >&2
        exit "${status:-1}"
    fi

    sleep 1
done

if is_docker_ready; then
    exit 0
fi

echo "Docker daemon did not become ready within ${DOCKER_READY_TIMEOUT_SECONDS} seconds; see $DOCKER_LOG_FILE" >&2
kill "$dockerd_pid" 2>/dev/null || true
wait "$dockerd_pid" 2>/dev/null || true
exit 1
