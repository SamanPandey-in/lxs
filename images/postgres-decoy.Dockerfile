FROM postgres:16-alpine
COPY images/postgres-decoy/entrypoint.sh /usr/local/bin/lxs-postgres-entrypoint
RUN chmod 0555 /usr/local/bin/lxs-postgres-entrypoint \
 && mkdir -p /var/log/lxs \
 && chown postgres:postgres /var/log/lxs
ENTRYPOINT ["/usr/local/bin/lxs-postgres-entrypoint"]
CMD ["postgres"]
