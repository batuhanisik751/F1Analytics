# The stock postgres:16 image ships without a CA bundle, so libpq inside the container cannot
# verify a remote certificate: every `sslmode=verify-full` connection to the production database
# (neon_migrate.sh, push_remote.py, db_ask_verify.sh) fails with "certificate verify failed".
# One layer fixes it durably; `apt-get install` by hand is lost when the container is recreated.
FROM postgres:16
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
