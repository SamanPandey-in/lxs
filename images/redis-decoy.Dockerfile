FROM python:3.12-alpine
RUN addgroup -S -g 10001 lxs && adduser -S -D -H -u 10001 -G lxs lxs
WORKDIR /app
COPY images/redis-decoy/server.py /app/server.py
RUN chmod 0555 /app/server.py && mkdir -p /var/log/lxs && chown -R 10001:10001 /var/log/lxs
USER 10001:10001
EXPOSE 6379
CMD ["python3", "/app/server.py"]
