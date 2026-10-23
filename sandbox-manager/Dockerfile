FROM docker:29.9.1-cli AS dockercli

FROM python:3.13-slim

# The manager drives the host daemon through the mounted socket. The docker CLI
# is a self-contained Go binary, so copy it instead of installing a second
# distribution (pinned to the 29.x CLI the stack is tested with).
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

RUN pip install --no-cache-dir "psycopg[binary]==3.2.10"

WORKDIR /app
COPY sandbox_manager.py ./

ENV PYTHONUNBUFFERED=1 \
    LISTEN_ADDR=0.0.0.0 \
    LISTEN_PORT=8090

EXPOSE 8090

CMD ["python", "sandbox_manager.py"]
