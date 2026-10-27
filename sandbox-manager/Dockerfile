FROM docker:29.9.1-cli AS dockercli

FROM python:3.13-slim

# The manager drives the host daemon through the mounted socket. The docker CLI
# is a self-contained Go binary, so copy it instead of installing a second
# distribution (pinned to the 29.x CLI the stack is tested with).
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

RUN pip install --no-cache-dir "psycopg[binary]==3.2.10" "cryptography==46.0.1"

# iptables is the host wall: the manager installs one INPUT DROP rule per
# sandbox bridge through a short-lived host-network NET_ADMIN helper (docker
# has no knob for the bridge-to-host path; see sandbox_manager.py).
RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY sandbox_manager.py test_sandbox_manager.py seccomp-no-ptrace.json ./

ENV PYTHONUNBUFFERED=1 \
    LISTEN_ADDR=0.0.0.0 \
    LISTEN_PORT=8090

EXPOSE 8090

CMD ["python", "sandbox_manager.py"]
