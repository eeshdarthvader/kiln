# Use published security releases directly when internal caches lack the tag.
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490
ARG BASE_IMAGE=docker.io/library/ubuntu:24.04
FROM ${UV_IMAGE} AS uv
FROM ${BASE_IMAGE}

# Base tools and Ubuntu security fixes.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
        bash build-essential ca-certificates curl file git \
        iproute2 iptables jq less libatomic1 libstdc++6 pkg-config procps ripgrep tar tini \
        unzip util-linux vim-tiny wget xz-utils zip zlib1g \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI from its official APT repository.
RUN curl -fsSL --retry 3 \
        https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && gh --version \
    && rm -rf /var/lib/apt/lists/*

# Docker's signed Ubuntu repository supplies the engine and its runtime dependencies.
ARG DOCKER_VERSION=5:29.9.3-1~ubuntu.24.04~noble
ARG CONTAINERD_VERSION=2.4.2-4~ubuntu.24.04~noble
ARG BUILDX_VERSION=0.39.0-1~ubuntu.24.04~noble
ARG COMPOSE_VERSION=5.7.1-1~ubuntu.24.04~noble
# The entrypoint owns daemon startup; package installs must not start services.
# Docker does not use ctr. Exclude it even on future containerd reinstalls.
RUN install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL --retry 3 https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && printf '%s\n' 'path-exclude=/usr/bin/ctr' 'path-exclude=/usr/share/man/man8/ctr.8.gz' \
        > /etc/dpkg/dpkg.cfg.d/exclude-ctr \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        "docker-ce=${DOCKER_VERSION}" "docker-ce-cli=${DOCKER_VERSION}" \
        "containerd.io=${CONTAINERD_VERSION}" "docker-buildx-plugin=${BUILDX_VERSION}" \
        "docker-compose-plugin=${COMPOSE_VERSION}" \
    && ln -s /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose \
    && docker --version && dockerd --version && runc --version \
    && docker buildx version && docker compose version \
    && ! command -v ctr \
    && rm -rf /var/lib/apt/lists/*

# Python and uv.
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    PYTHONUNBUFFERED=1
RUN uv python install 3.14.8 --default \
    && python --version

# Registries for build-time and runtime package installs.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    UV_DEFAULT_INDEX=https://pypi.org/simple/

# AWS MCP proxy, installed ahead of time so startup needs no package downloads.
RUN uv venv --python /usr/local/bin/python /opt/aws-mcp \
    && uv pip install --no-cache --python /opt/aws-mcp/bin/python mcp-proxy-for-aws-cli==1.8.0

# AWS CLI.
ARG AWS_CLI_VERSION=2.39.3
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        arm64) architecture=aarch64 ;; \
        amd64) architecture=x86_64 ;; \
        *) echo 'Unsupported architecture' >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 "https://awscli.amazonaws.com/awscli-exe-linux-${architecture}-${AWS_CLI_VERSION}.zip" -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/awscliv2.zip /tmp/aws; \
    aws --version

# Docker's package creates its group; Ubuntu's default user occupies UID/GID 1000.
RUN if id -u ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
    && groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid agent --groups docker --create-home --shell /bin/bash agent

# Required Node runtime; shims resolve explicitly installed project tools at runtime.
COPY image/tool-versions.json /opt/mise/tool-versions.json
ENV MISE_DATA_DIR=/opt/mise \
    MISE_CONFIG_DIR=/home/agent/.config/mise \
    MISE_CACHE_DIR=/opt/mise/cache \
    MISE_AUTO_INSTALL=false \
    PATH=/opt/mise/shims:$PATH
COPY --chown=agent:agent image/mise.toml /home/agent/.config/mise/config.toml
COPY image/install-tools.sh /tmp/install-tools.sh
RUN HOME=/home/agent sh /tmp/install-tools.sh \
    && chown -R agent:agent /opt/mise \
    && rm -rf /tmp/install-tools.sh /opt/mise/cache
COPY image/mise.sh /etc/profile.d/mise.sh
RUN cat /etc/profile.d/mise.sh >> /etc/bash.bashrc

# OpenCode v2 native binary, without npm installer scripts.
ARG OPENCODE_VERSION=2.2.7
RUN set -eu; \
    export MISE_OFFLINE=true; \
    case "$(dpkg --print-architecture)" in \
        arm64) package=@opencode/cli-linux-arm64 ;; \
        amd64) package=@opencode/cli-linux-x64-baseline ;; \
        *) echo 'Unsupported architecture' >&2; exit 1 ;; \
    esac; \
    npm install --prefix /opt/opencode --no-save --package-lock=false \
        --ignore-scripts --omit=dev --no-audit --no-fund "${package}@${OPENCODE_VERSION}"; \
    ln -s "node_modules/${package}/bin/opencode" /opt/opencode/opencode; \
    test "$(/opt/opencode/opencode --version)" = "opencode v${OPENCODE_VERSION}"

# Pin Superpowers at build time; runtime startup requires no plugin download.
ARG SUPERPOWERS_COMMIT=22f0b463e7a5e579904dd6211a520321035526f7
RUN git init /opt/superpowers \
    && git -C /opt/superpowers remote add origin https://github.com/obra/superpowers.git \
    && git -C /opt/superpowers fetch --depth=1 origin "$SUPERPOWERS_COMMIT" \
    && git -C /opt/superpowers checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/superpowers rev-parse HEAD)" = "$SUPERPOWERS_COMMIT" \
    && test -f /opt/superpowers/index.js \
    && rm -rf /opt/superpowers/.git
ENV SUPERPOWERS_DISABLE_TELEMETRY=1

# Add engineering guidance without installing a second lifecycle/bootstrap plugin.
ARG ENGINEERING_SKILLS_COMMIT=301b02b12bff98e4688e6984af6556802322bbde
RUN git init /opt/engineering-skills \
    && git -C /opt/engineering-skills remote add origin https://github.com/addyosmani/agent-skills.git \
    && git -C /opt/engineering-skills fetch --depth=1 origin "$ENGINEERING_SKILLS_COMMIT" \
    && git -C /opt/engineering-skills checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/engineering-skills rev-parse HEAD)" = "$ENGINEERING_SKILLS_COMMIT" \
    && rm -rf /opt/engineering-skills/.git \
    && mkdir -p /home/agent/.config/opencode/skills \
    && for skill in code-review-and-quality code-simplification git-workflow-and-versioning; do \
         test -f "/opt/engineering-skills/skills/$skill/SKILL.md"; \
         ln -s "/opt/engineering-skills/skills/$skill" "/home/agent/.config/opencode/skills/$skill"; \
       done

# Keep factory classification and integration; Superpowers supplies development skills.
COPY --chown=agent:agent skills/agents/build.md skills/agents/classifier.md skills/agents/plan-reviewer.md /home/agent/.config/opencode/agents/
COPY --chown=agent:agent skills/factory-classifier/ /home/agent/.config/opencode/skills/factory-classifier/
COPY --chown=agent:agent skills/factory-build-tools/ /home/agent/.config/opencode/skills/factory-build-tools/
COPY --chown=agent:agent skills/factory-draft-pr/ /home/agent/.config/opencode/skills/factory-draft-pr/

# Keep the trusted Git egress configuration independent of task workspaces.
COPY image/github-egress-proxy-ca.crt /usr/local/share/ca-certificates/github-egress-proxy.crt
COPY image/gitconfig /etc/gitconfig

# Runtime launchers and GitHub proxy wrappers.
COPY --chmod=755 image/opencode.sh /usr/local/bin/opencode
COPY --chmod=755 image/aws-mcp.sh /usr/local/bin/aws-mcp
COPY --chmod=755 image/github-cli.sh /usr/local/bin/github-cli
COPY --chmod=755 image/entrypoint.sh /usr/local/bin/entrypoint
COPY --chmod=755 image/docker-start.sh /usr/local/bin/docker-start
RUN ln -s github-cli /usr/local/bin/git \
    && ln -s github-cli /usr/local/bin/gh

# Application, outside task workspaces.
COPY package.json package-lock.json tsconfig.json /opt/sawd-exec-server/
COPY src/ /opt/sawd-exec-server/src/
COPY ui/ /opt/sawd-exec-server/ui/
COPY vite.config.ts /opt/sawd-exec-server/vite.config.ts
WORKDIR /opt/sawd-exec-server
RUN export MISE_OFFLINE=true; npm ci \
    && npm run build \
    && npm prune --omit=dev

# Non-root runtime; defaults for ports and workspace are in the entrypoint.
ENV HOME=/home/agent USER=agent LOGNAME=agent \
    PATH=/home/agent/.local/bin:$PATH
RUN mkdir -p /workspace/sawd /home/agent/.local/bin /opt/mise/cache \
    && chown -R agent:agent /workspace /home/agent /opt/mise/cache

USER agent
WORKDIR /workspace/sawd
EXPOSE 3773 3775

# Readiness needs no password; the entrypoint handles either service exiting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=210s --retries=3 \
    CMD test "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT:-3775}/readyz")" = 200

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "3773"]
