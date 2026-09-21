#!/usr/bin/env bash
# scripts/neon_migrate.sh — bring a remote database up to the repo's schema and roles
# (OPS_SPEC §4.2, §6.3). Idempotent: run it after every merged migration, and before the
# first push_remote.py --full.
#
#   scripts/neon_migrate.sh "$OWNER_URL"        (or OWNER_URL in the environment)
#
# Order, mirroring the local Makefile order on a fresh machine:
#   1. drizzle migrations       web/drizzle/*.sql via `npm run db:migrate` (DDL lives there only)
#   2. scripts/sql/0005_ask_views.sql       the `ask` views (grant skipped with a NOTICE until f1_ask exists)
#   3. scripts/sql/0005_roles.sql           f1_ask + f1_ask_log
#   4. scripts/sql/0005_ask_views.sql again the enumerated GRANT now lands
#   5. scripts/sql/ask_views_telemetry.sql  boundary assertions; invalidates ask_answer_cache
#   6. scripts/sql/0011_web_role.sql        f1_web  (the app's DATABASE_URL)
#   7. scripts/sql/0012_push_role.sql       f1_push (the nightly credential)
#
# Passwords come from the environment, never from argv or a file in the repo:
#   ASK_PASSWORD  ASK_LOG_PASSWORD  F1_WEB_PASSWORD  F1_PUSH_PASSWORD
# Each role file rotates its password to the value given, so pass the SAME values on every
# run (keep them in a mode-600 file outside the repo and `source` it) unless a rotation is
# intended, in which case Vercel / remote.env must be updated afterwards.
#
# psql runs inside the f1-postgres container (no host psql; it speaks TLS and resolves the
# internet). The DSN must carry sslmode=verify-full&sslrootcert=system for a remote host
# (F9); node's pg treats sslrootcert as a file path, so that one parameter is stripped for
# the drizzle step, where verify-full already uses the system trust store.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OWNER_URL="${1:-${OWNER_URL:-}}"
PSQL="${PSQL:-docker exec -i f1-postgres psql}"

die() { printf 'neon_migrate: %s\n' "$*" >&2; exit 2; }

[ -n "$OWNER_URL" ] || die 'usage: scripts/neon_migrate.sh OWNER_URL  (owner role, direct endpoint)'
case "$OWNER_URL" in
  postgres://*|postgresql://*) ;;
  *) die 'OWNER_URL must be a postgres:// connection string' ;;
esac
host="$(printf '%s' "$OWNER_URL" | sed -E 's%^[a-z]+://([^@/]*@)?([^:/?]+).*%\2%')"
case "$host" in
  localhost|127.0.0.1|::1) remote=0 ;;
  *) remote=1
     printf '%s' "$OWNER_URL" | grep -q 'sslmode=verify-full' \
       || die "a remote DSN must carry sslmode=verify-full&sslrootcert=system (F9); host is $host" ;;
esac
for v in ASK_PASSWORD ASK_LOG_PASSWORD F1_WEB_PASSWORD F1_PUSH_PASSWORD; do
  pw="${!v:-}"
  [ -n "$pw" ] || die "$v is not set (export the four role passwords first; >= 8 chars each)"
  [ "${#pw}" -ge 8 ] || die "$v is shorter than 8 chars"
done
docker inspect -f '{{.State.Running}}' f1-postgres 2>/dev/null | grep -q true \
  || die 'container f1-postgres is not running (its psql applies the SQL files)'

# sql FILE [psql -v args...]  — apply one file with the owner DSN, stop on the first error
sql() {
  f="$1"; shift
  printf '\n--- %s\n' "$f"
  $PSQL "$OWNER_URL" -X -q -v ON_ERROR_STOP=1 "$@" -f - < "$ROOT/$f"
}

# The only NEXT_PUBLIC-free, DDL-issuing step: drizzle's own ledger (drizzle.__drizzle_migrations)
# makes it a no-op when nothing is pending.
DRIZZLE_URL="$(printf '%s' "$OWNER_URL" | sed -E 's/[&?]sslrootcert=system//')"
printf -- '--- web/drizzle (db:migrate) against %s\n' "$host"
DATABASE_URL="$DRIZZLE_URL" npm --prefix "$ROOT/web" run --silent db:migrate

sql scripts/sql/0005_ask_views.sql
sql scripts/sql/0005_roles.sql       -v ask_password="$ASK_PASSWORD" -v ask_log_password="$ASK_LOG_PASSWORD"
sql scripts/sql/0005_ask_views.sql
sql scripts/sql/ask_views_telemetry.sql
sql scripts/sql/0011_web_role.sql    -v web_password="$F1_WEB_PASSWORD"
sql scripts/sql/0012_push_role.sql   -v push_password="$F1_PUSH_PASSWORD"

printf '\n--- state on %s\n' "$host"
$PSQL "$OWNER_URL" -X -q -tA -v ON_ERROR_STOP=1 -c "
  SELECT 'migrations applied: ' || count(*) FROM drizzle.__drizzle_migrations
  UNION ALL SELECT 'latest migration:   idx ' || (count(*) - 1) FROM drizzle.__drizzle_migrations
  UNION ALL SELECT 'ask views:          ' || count(*) FROM pg_views WHERE schemaname = 'ask'
  UNION ALL SELECT 'login roles:        ' || string_agg(rolname, ', ' ORDER BY rolname)
    FROM pg_roles WHERE rolcanlogin AND rolname IN ('f1_ask','f1_ask_log','f1_push','f1_web')
  UNION ALL SELECT 'data_release rows:  ' || count(*) FROM data_release"
printf '\nnext: ASK_PASSWORD=... ASK_LOG_PASSWORD=... F1_WEB_PASSWORD=... scripts/db_ask_verify.sh "%s"\n' "$(printf '%s' "$OWNER_URL" | sed -E 's%://[^@/]*@%://…@%')"
