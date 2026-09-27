ARG BUILD_FROM=ghcr.io/hassio-addons/base:21.0.6
ARG SPARKYFITNESS_VERSION="1.7.2"

# SparkyFitness publishes container images, but as three separate ones: the
# server, the client behind an NGINX of its own, and a database. This app is a
# single container, so the server and the client are built from source here
# instead, the way upstream's own images build them.
#
# Both come out of one pnpm workspace, and are patched before they are built:
# the client to work below the path Ingress serves it from, the server to sign
# in whoever Home Assistant says is asking. patches/ingress.py has the details.
# hadolint ignore=DL3006
FROM ${BUILD_FROM} AS builder
ARG SPARKYFITNESS_VERSION

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /opt/sparkyfitness-src

COPY patches /patches

# The version of pnpm is the one upstream names in its workspace, which its
# lockfile was written with.
#
# The client is built with Vite directly. Upstream's build script runs its
# type checks, linters and formatters first, which would only be checking our
# patches against upstream's code style.
#
# The server is deployed with its development dependencies, as upstream does
# too, but then compiled to JavaScript right where it is, rather than compiled
# again on every start the way upstream runs it; see patches/compile.mjs.
# Everything it does not run on is then taken out again, which is most of it,
# the compiler included; see patches/prune.py.
# hadolint ignore=DL3016
RUN \
    apk add --no-cache \
        nodejs=24.18.1-r0 \
        npm=11.12.1-r0 \
        python3=3.14.7-r1 \
    \
    && curl -J -L -o /tmp/sparkyfitness.tar.gz \
        "https://github.com/CodeWithCJ/SparkyFitness/archive/refs/tags/v${SPARKYFITNESS_VERSION}.tar.gz" \
    && tar zxf /tmp/sparkyfitness.tar.gz \
        -C /opt/sparkyfitness-src --strip-components=1 \
    \
    && npm install \
        --global \
        --no-audit \
        --no-fund \
        --no-update-notifier \
        "$(python3 -c 'import json; print(json.load(open("package.json"))["packageManager"])')" \
    \
    && python3 /patches/ingress.py source /opt/sparkyfitness-src \
    \
    && pnpm install \
        --frozen-lockfile \
        --filter "sparkyfitnessserver..." \
        --filter "sparkyfitnessfrontend..." \
    \
    && pnpm --filter sparkyfitnessfrontend exec vite build \
    && python3 /patches/ingress.py dist \
        /opt/sparkyfitness-src/SparkyFitnessFrontend/dist \
    && mkdir -p /opt/sparkyfitness \
    && mv /opt/sparkyfitness-src/SparkyFitnessFrontend/dist \
        /opt/sparkyfitness/frontend \
    \
    && pnpm --filter sparkyfitnessserver deploy /opt/sparkyfitness/server \
    && node /patches/compile.mjs /opt/sparkyfitness/server \
    && node /patches/trace-imports.mjs /opt/sparkyfitness/server \
        > /tmp/server-imports \
    && python3 /patches/prune.py /opt/sparkyfitness/server /tmp/server-imports

# hadolint ignore=DL3006
FROM ${BUILD_FROM}

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# PostgreSQL is pinned to a major version by its package name, so a newer
# Alpine in the base image cannot move this app to another major behind its
# back. PostgreSQL cannot read a data directory written by another major, so
# that is a deliberate step, described in POSTGRES-UPGRADE.md.
RUN \
    apk add --no-cache \
        nginx=1.30.4-r1 \
        nodejs=24.18.1-r0 \
        postgresql18-client=18.6-r0 \
        postgresql18=18.6-r0 \
    \
    && rm -f -r \
        /etc/nginx \
        /tmp/*

COPY --from=builder /opt/sparkyfitness /opt/sparkyfitness

# Copy root filesystem
COPY rootfs /

# Health check
HEALTHCHECK \
    CMD curl --silent --fail http://127.0.0.1:3010/api/health || exit 1

# Build arguments
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION

# Labels
LABEL \
    io.hass.name="${BUILD_NAME}" \
    io.hass.description="${BUILD_DESCRIPTION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Franck Nijhof <opensource@frenck.dev>" \
    org.opencontainers.image.title="${BUILD_NAME}" \
    org.opencontainers.image.description="${BUILD_DESCRIPTION}" \
    org.opencontainers.image.vendor="Home Assistant Community Apps" \
    org.opencontainers.image.authors="Franck Nijhof <opensource@frenck.dev>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://frenck.dev/home-assistant-apps" \
    org.opencontainers.image.source="https://github.com/${BUILD_REPOSITORY}" \
    org.opencontainers.image.documentation="https://github.com/${BUILD_REPOSITORY}/blob/main/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}
