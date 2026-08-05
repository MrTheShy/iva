# Container image for iva.
#
# Two reasons this exists, and only the second one is about convenience:
#
#   1. TECH_DEBT.md #2 — the bash tool is host-native and deliberately bypasses
#      eve's sandbox: "the command runs directly on the real VPS filesystem".
#      Combined with TECH_DEBT.md #1 — no approval gate, every tool call runs
#      unsupervised — that is an always-on assistant executing arbitrary
#      commands on a machine with your SSH keys on it. In a container the blast
#      radius is whatever you mount, and nothing else.
#
#   2. The project needs Node 24. Running it in a container means not installing
#      a second Node on the host, and not touching PATH.
#
# What this does NOT solve: a container is process isolation, not a security
# sandbox. Anything you mount is reachable — including the vault, which is the
# whole point of mounting it. Keep the vault a git repo with a remote (doctor.ts
# already commits and pushes nightly) so a bad `rm` costs you one day, and
# restrict egress at the network level — see compose.yaml.
#
# Nor does it solve the approval gate. An agent that executes without asking
# still executes without asking; it just does so somewhere less expensive.

FROM node:24-slim

# git       — the vault is a git repo; doctor.ts commits and pushes it
# python3   — scripts/autograph/*.py (dedup, enforce, moc, graph) and the
#             security-defense skill (sanitizer.py, outbound_gate.py)
# ca-certs  — outbound HTTPS to the model providers
#
# Deliberately absent: gh, ffmpeg, pandoc, poppler-utils. They are for skills
# you may never use (voice notes, document conversion). Add them when a skill
# actually fails, not before — every one of them widens what a compromised
# agent can run.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# uv, for the autograph scripts. Pinned installer, not `curl | sh` into root.
ENV UV_INSTALL_DIR=/usr/local/bin
RUN python3 -m venv /opt/uv && /opt/uv/bin/pip install --no-cache-dir uv \
    && ln -s /opt/uv/bin/uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first: this layer is cached until package.json changes.
COPY package.json package-lock.json* ./
COPY patches ./patches
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

COPY . .

# `eve start` refuses to run without build output — it does not build on the
# fly. Doing it here means the image is self-contained and startup is fast;
# doing it at run time would rebuild on every restart.
RUN npm run build

# Not root. The agent runs arbitrary shell commands by design — it should not
# be able to write outside what it owns.
RUN chown -R node:node /app
USER node

# The vault lives here, mounted from outside. It is the user's data: it does not
# belong in an image layer. The variable name is the one init-vault.mjs and the
# memory scripts actually read — ASSISTANT_VAULT_DIR, not VAULT_DIR.
ENV ASSISTANT_VAULT_DIR=/data/vault

# Runtime state — Telegram offset, settings, usage, schedule catch-up markers.
# Default is ./data relative to the workdir, which lives inside the image and
# vanishes on every restart: the poller then re-reads or skips messages, the
# spend log resets, and the schedules lose their catch-up baseline. Point it at
# the volume so a restart is a restart, not amnesia.
ENV ASSISTANT_DATA_DIR=/data/state

# The nightly doctor commits the vault, and git refuses to commit without an
# identity. A container has no ~/.gitconfig, so it goes here — deliberately
# generic: the vault is personal data, its commit log should not carry an
# identity that travels with a backup.
ENV GIT_AUTHOR_NAME=iva \
    GIT_AUTHOR_EMAIL=iva@localhost \
    GIT_COMMITTER_NAME=iva \
    GIT_COMMITTER_EMAIL=iva@localhost

VOLUME ["/data"]

EXPOSE 3000

CMD ["npm", "run", "start"]
