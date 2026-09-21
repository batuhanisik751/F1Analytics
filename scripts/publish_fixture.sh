#!/usr/bin/env bash
# Cut the CI fixture from the local database and publish it as a GitHub Release asset.
#
#   scripts/publish_fixture.sh               build, verify, upload (needs a clean tree and gh)
#   scripts/publish_fixture.sh --commit      ...and pin the asset in tests/ci_fixture.txt, committed
#   scripts/publish_fixture.sh --build-only  build and verify into output/ only; no gh, no pin
#
# What leaves the laptop: a `pg_dump -Fc --no-owner --no-privileges` of the whole database with
# the DATA of every table in scripts/push_remote.py::EXCLUDE_TABLES left out (their DDL stays),
# except the STUB_TABLES, whose rows cross with every SCRUB column rewritten exactly as the
# nightly push does it (`session_ingests.run_id` is a NOT NULL foreign key into `ingest_runs`,
# so an archive without those rows does not restore). `session_ingests.error` is NULL in the
# copy, one synthetic `data_release` row is added so the site footer renders a date, and nothing
# else changes. `wp_model_artifact` is kept on purpose: tests/test_winprob.py reads it.
#
# How the scrub is done without writing to the real database: the dump is streamed straight
# into a throw-away postgres:16 container, the scrub UPDATE and the release INSERT run there,
# and the archive is cut from that copy. The archive is then restored a second time, into a
# fresh database in the same container, and the invariants below are asserted on the restore
# before anything is uploaded. The real database only ever sees pg_dump.
#
# No make, no host psql: every database command goes through `docker exec`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SOURCE_CONTAINER="${F1_SOURCE_CONTAINER:-f1-postgres}"
SOURCE_USER=f1
SOURCE_DB=f1
SCRATCH="f1-fixture-check"
SCRATCH_IMAGE="postgres:16"
RELEASE_TAG="fixtures"
TAG="fixture-$(date -u +%Y-%m-%d)"
ASSET="$TAG.dump"
OUT_DIR="$ROOT/output"
OUT="$OUT_DIR/$ASSET"
PIN="$ROOT/tests/ci_fixture.txt"
BASELINE="$ROOT/db/trail_census_baseline.json"
PY="$ROOT/.venv/bin/python"

MODE=publish
case "${1:-}" in
  "")            MODE=publish ;;
  --commit)      MODE=commit ;;
  --build-only)  MODE=build ;;
  -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "publish_fixture: unknown argument '$1' (try --help)" >&2; exit 2 ;;
esac

log()  { printf '[publish_fixture] %s\n' "$*"; }
die()  { printf '[publish_fixture] ERROR: %s\n' "$*" >&2; exit 1; }

# --- preconditions --------------------------------------------------------------------------
# A fixture is pinned by commit; cutting it from a tree that git does not know about would pin
# CI to a database state no commit describes. --build-only writes nothing tracked, so it is the
# one mode allowed to run on a dirty tree (it says so).
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$MODE" == build ]]; then
    log "WARNING: working tree is dirty; --build-only continues because it commits nothing"
  else
    die "working tree is dirty; commit or stash first (git status --porcelain is non-empty)"
  fi
fi
command -v docker >/dev/null || die "docker is not on PATH"
docker inspect -f '{{.State.Running}}' "$SOURCE_CONTAINER" 2>/dev/null | grep -qx true \
  || die "container $SOURCE_CONTAINER is not running"
[[ -x "$PY" ]] || die "$PY is missing (create the venv first)"
[[ -f "$BASELINE" ]] || die "$BASELINE is missing; the fixture is pinned together with it"
if [[ "$MODE" != build ]]; then
  command -v gh >/dev/null || die "gh is not on PATH (use --build-only to skip the upload)"
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated (gh auth login)"
fi
if docker inspect "$SCRATCH" >/dev/null 2>&1; then
  die "container $SCRATCH already exists; a previous run did not clean up (docker rm -f $SCRATCH)"
fi
mkdir -p "$OUT_DIR"

# --- the exclude, stub and scrub sets are Python constants shared with the nightly push ------
eval "$("$PY" - <<'PYEOF'
import shlex
from scripts.push_remote import EXCLUDE_TABLES, STUB_TABLES, SCRUB
updates, checks = [], []
for table, cols in sorted(SCRUB.items()):
    sets = ", ".join(f"{c} = {e}" for c, e in sorted(cols.items()))
    where = " OR ".join(f"{c} IS DISTINCT FROM {e}" for c, e in sorted(cols.items()))
    updates.append(f"UPDATE {table} SET {sets} WHERE {where}")
    checks.append(f"{table}|SELECT count(*) FROM {table} WHERE {where}")
print("EXCLUDE_DATA=" + shlex.quote(" ".join(sorted(EXCLUDE_TABLES - STUB_TABLES))))
print("STUB_TABLES=" + shlex.quote(" ".join(sorted(STUB_TABLES))))
print("SCRUB_SQL=" + shlex.quote("\n".join(updates)))
print("SCRUB_CHECKS=" + shlex.quote("\n".join(checks)))
PYEOF
)"
[[ -n "$EXCLUDE_DATA" && -n "$SCRUB_SQL" ]] || die "scripts.push_remote gave an empty exclude or scrub set"
EXCLUDE_FLAGS=()
for t in $EXCLUDE_DATA; do EXCLUDE_FLAGS+=("--exclude-table-data=$t"); done
log "data excluded for: $EXCLUDE_DATA; rows cross as scrubbed stubs for: $STUB_TABLES"

# --- scratch container ----------------------------------------------------------------------
cleanup() { docker rm -f "$SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$SCRATCH" -e POSTGRES_PASSWORD=x "$SCRATCH_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$SCRATCH" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
docker exec "$SCRATCH" pg_isready -U postgres -q || die "$SCRATCH did not become ready in 60 s"
# The restore is done as a role with the same name as the source owner so that the archive
# cut from the copy carries no reference to `postgres`.
spsql() { docker exec "$SCRATCH" psql -U postgres -v ON_ERROR_STOP=1 -X -q "$@"; }
spsql -d postgres -c "CREATE ROLE $SOURCE_USER LOGIN SUPERUSER" >/dev/null
spsql -d postgres -c "CREATE DATABASE f1_build OWNER $SOURCE_USER" >/dev/null
bpsql() { docker exec "$SCRATCH" psql -U "$SOURCE_USER" -d f1_build -v ON_ERROR_STOP=1 -X -At "$@"; }

# --- stage 1: dump the real database (read only) straight into the scratch copy --------------
log "streaming pg_dump of $SOURCE_DB into $SCRATCH/f1_build"
t0=$(date +%s)
docker exec "$SOURCE_CONTAINER" pg_dump -U "$SOURCE_USER" -d "$SOURCE_DB" -Fc \
    --no-owner --no-privileges "${EXCLUDE_FLAGS[@]}" \
  | docker exec -i "$SCRATCH" pg_restore -U "$SOURCE_USER" -d f1_build --no-owner --no-privileges -j 1
log "stage 1 done in $(( $(date +%s) - t0 )) s"

# --- stage 2: scrub in the copy, then add the one row the site footer reads ------------------
while IFS= read -r stmt; do
  n=$(bpsql -c "$stmt" | sed 's/UPDATE //')
  log "scrub: ${stmt%% WHERE*} -> ${n:-0} row(s)"
done <<< "$SCRUB_SQL"
census_sha=$(shasum -a 256 "$BASELINE" | cut -d' ' -f1)
sessions=$(bpsql -c "SELECT count(*) FROM sessions")
rows=$(bpsql -c "SELECT coalesce(sum((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint), 0) FROM pg_tables WHERE schemaname = 'public'")
bpsql -c "INSERT INTO data_release (pushed_at, sessions_pushed, rows_pushed, census_sha256)
          VALUES ('$(date -u +%Y-%m-%d) 00:00:00+00', $sessions, $rows, '$census_sha')" >/dev/null
log "data_release row: $sessions sessions, $rows rows, census $census_sha"

# --- stage 3: cut the archive from the copy --------------------------------------------------
log "writing $OUT"
docker exec "$SCRATCH" pg_dump -U "$SOURCE_USER" -d f1_build -Fc --no-owner --no-privileges > "$OUT"
# The archive is compressed, so `strings` on it proves little; scan an uncompressed dump of
# the same copy for the one pattern that identifies this laptop.
hits=$(docker exec "$SCRATCH" pg_dump -U "$SOURCE_USER" -d f1_build -Fp --no-owner --no-privileges \
  | awk 'BEGIN{t="(ddl)"} /^COPY /{t=$2} /^\\\.$/{t="(ddl)"} index($0,"/Users"){print t}' | sort | uniq -c | tr -s ' \n' ' ;')
[[ -z "$hits" ]] || die "plain-text dump of the scrubbed copy still mentions '/Users' (count table):$hits"
log "plain-text scan: 0 lines mention /Users"

# --- stage 4: restore the archive into a fresh database and assert what CI will see ----------
spsql -d postgres -c "CREATE DATABASE f1_check OWNER $SOURCE_USER" >/dev/null
cpsql() { docker exec "$SCRATCH" psql -U "$SOURCE_USER" -d f1_check -v ON_ERROR_STOP=1 -X -q -At "$@"; }
t1=$(date +%s)
docker exec -i "$SCRATCH" pg_restore -U "$SOURCE_USER" -d f1_check --no-owner --no-privileges -j 1 < "$OUT"
restore_s=$(( $(date +%s) - t1 ))
log "restore of $ASSET into a fresh database: $restore_s s"

expect() {  # expect <label> <sql> <comparison> <value>
  local got; got=$(cpsql -c "$2")
  if test "$got" "$3" "$4"; then log "ok   $1 = $got"; else die "$1 = $got, expected $3 $4"; fi
}
for t in $EXCLUDE_DATA; do
  expect "$t rows" "SELECT count(*) FROM $t" -eq 0
done
for t in $STUB_TABLES; do
  expect "$t stub rows" "SELECT count(*) FROM $t" -gt 0
done
while IFS='|' read -r t sql; do
  expect "$t rows with an unscrubbed column" "$sql" -eq 0
done <<< "$SCRUB_CHECKS"
expect "session_ingests rows with an error" "SELECT count(*) FROM session_ingests WHERE error IS NOT NULL" -eq 0
expect "session_ingests rows" "SELECT count(*) FROM session_ingests" -gt 0
expect "wp_model_artifact rows" "SELECT count(*) FROM wp_model_artifact" -gt 0
expect "sessions rows" "SELECT count(*) FROM sessions" -eq "$sessions"
expect "data_release rows" "SELECT count(*) FROM data_release" -eq 1
repo_migrations=$(ls "$ROOT"/web/drizzle/*.sql | wc -l | tr -d ' ')
expect "migration ledger rows" "SELECT count(*) FROM drizzle.__drizzle_migrations" -eq "$repo_migrations"
expect "ask views" "SELECT count(*) FROM pg_views WHERE schemaname = 'ask'" -gt 0
# The same scan `strings | grep` would do, without depending on a toolchain being installed.
strings_hits=$(LC_ALL=C tr -c '[:print:]\n' '\n' < "$OUT" | grep -c '/Users' || true)
[[ "$strings_hits" == 0 ]] || die "printable strings of $ASSET mention /Users on $strings_hits line(s)"
log "ok   printable strings of $ASSET | grep -c /Users = 0"

sha=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
bytes=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT")
log "archive $OUT: $bytes bytes, sha256 $sha"
if [[ "$MODE" == build ]]; then
  log "--build-only: not uploaded, not pinned"
  exit 0
fi

# --- stage 5: publish to the permanent Release, then pin ------------------------------------
# One Release tagged `fixtures` holds every cut as a dated asset; the tag never moves. CI
# downloads the asset named in tests/ci_fixture.txt and checks its sha256 before restoring.
if ! gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
  gh release create "$RELEASE_TAG" --title "CI fixtures" \
    --notes "Scrubbed database snapshots that CI restores. Pinned by sha256 in tests/ci_fixture.txt." \
    >/dev/null
  log "created Release $RELEASE_TAG"
fi
gh release upload "$RELEASE_TAG" "$OUT" --clobber >/dev/null
log "uploaded $ASSET to Release $RELEASE_TAG"

pin_lines="tag=$TAG
release=$RELEASE_TAG
asset=$ASSET
sha256=$sha
bytes=$bytes
migrations=$repo_migrations
sessions=$sessions
census_sha256=$census_sha"
if [[ "$MODE" == commit ]]; then
  printf '%s\n' "$pin_lines" > "$PIN"
  git add -- "$PIN"
  git commit -qm "Pin CI fixture $TAG" -- "$PIN"
  log "pinned and committed $PIN"
else
  log "not pinned (re-run with --commit to write and commit tests/ci_fixture.txt):"
  printf '    %s\n' $pin_lines
fi
