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

# Python and uv.
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    PYTHONUNBUFFERED=1
RUN uv python install 3.14.8 --default \
    && python --version

# Ubuntu's default user occupies UID/GID 1000; agents run as that ID so files they
# write in the mounted worktree stay owned by a normal user.
RUN if id -u ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
    && groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid agent --create-home --shell /bin/bash agent

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

# Claude Code, pinned. Its install script only places the platform binary.
ARG CLAUDE_CODE_VERSION=2.1.317
RUN export MISE_OFFLINE=true; \
    npm install --prefix /opt/claude --no-save --package-lock=false --omit=dev \
        --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && ln -s /opt/claude/node_modules/.bin/claude /usr/local/bin/claude \
    && claude --version | grep -F "${CLAUDE_CODE_VERSION}"
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Keep the trusted Git egress configuration independent of task workspaces.
COPY image/github-egress-proxy-ca.crt /usr/local/share/ca-certificates/github-egress-proxy.crt
COPY image/gitconfig /etc/gitconfig

# Stage launcher and GitHub proxy wrappers.
COPY --chmod=755 image/github-cli.sh /usr/local/bin/github-cli
COPY --chmod=755 image/entrypoint.sh /usr/local/bin/entrypoint
RUN ln -s github-cli /usr/local/bin/git \
    && ln -s github-cli /usr/local/bin/gh

# Non-root runtime. The factory mounts the worktree and run directory and sets the workdir.
ENV HOME=/home/agent USER=agent LOGNAME=agent \
    PATH=/home/agent/.local/bin:$PATH
RUN mkdir -p /home/agent/.local/bin /opt/mise/cache \
    && chown -R agent:agent /home/agent /opt/mise/cache

USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint"]
