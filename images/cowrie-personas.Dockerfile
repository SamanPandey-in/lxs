# syntax=docker/dockerfile:1
# Cowrie with the LXS personas baked in. Build context: the monorepo root.
#   docker build -f images/cowrie-personas.Dockerfile -t ghcr.io/lxs/cowrie-personas:0.1.0 .
#
# Pin the upstream image by digest for releases:
#   --build-arg COWRIE_IMAGE=docker.io/cowrie/cowrie@sha256:<digest>
# Layout verified against docker.io/cowrie/cowrie@sha256:baf351038db967704dfa39f7ce860e8875c9456cdab72a9d3257c4247211050d
# (python 3.13, user 999, data in /cowrie/cowrie-git/src/cowrie/data, entrypoint /cowrie/cowrie-env/bin/python3).
# The upstream image has no shell, so every step below uses exec-form RUN with Cowrie's own interpreter.
ARG COWRIE_IMAGE=docker.io/cowrie/cowrie:latest

# --- stage 1: edit Cowrie's pickled fake filesystem with Cowrie's own interpreter ---------------------------
FROM ${COWRIE_IMAGE} AS persona-build
USER root
COPY data/personas /tmp/personas
COPY images/cowrie-personas/bake.py /tmp/bake.py
RUN ["/cowrie/cowrie-env/bin/python3", "/tmp/bake.py"]

# --- stage 2: runtime ----------------------------------------------------------------------------------------
FROM ${COWRIE_IMAGE}
COPY --from=persona-build /out/personas /cowrie/cowrie-git/share/cowrie/personas
# Default config: accepts admin/admin, forwarding disabled, JSON logging on, telnet off. `lxs build`
# mounts a per-decoy cowrie.cfg / userdb.txt over these (same safety properties, persona and hostname chosen per decoy).
COPY images/cowrie-personas/cowrie.cfg /cowrie/cowrie-git/etc/cowrie.cfg
COPY images/cowrie-personas/userdb.txt /cowrie/cowrie-git/etc/userdb.txt
LABEL org.opencontainers.image.title="lxs-cowrie-personas" \
      org.opencontainers.image.description="Cowrie SSH honeypot with LXS persona filesystems" \
      org.opencontainers.image.version="0.1.0"
EXPOSE 2222
# Upstream ENTRYPOINT/CMD (non-root user 999, twistd in the foreground) are inherited unchanged.
# Per-deployment honeytokens are overlaid by mounting <secrets>/honeyfs read-only at /cowrie/honeyfs-live:
# Cowrie's [honeypot] contents_path overrides the baked file contents with files found there.
