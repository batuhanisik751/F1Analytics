#!/usr/bin/env bash
# scripts/db_ask_verify.sh — the privilege gate (MODE3_SPEC §9 WP-2, OPS_SPEC §4.2 / F11).
#
#   scripts/db_ask_verify.sh [OWNER_URL]
#
# 34 assertions, each run against the live database AS THE ROLE IT IS ABOUT. A non-zero
# exit BLOCKS DEPLOY: it is the gate before ASK_DATABASE_URL is ever set in Vercel and
# before the first push_remote.py --full. It leaves no rows behind (every write probe runs
# inside a transaction that is rolled back).
#
# Connection strings. OWNER_URL is the first argument, else $OWNER_URL, else the local
# Docker DSN. The four app-role DSNs are derived from it by swapping the user info:
#   ASK_URL  f1_ask:$ASK_PASSWORD       LOG_URL  f1_ask_log:$ASK_LOG_PASSWORD
#   WEB_URL  f1_web:$F1_WEB_PASSWORD
# or given whole as env vars of those names. Locally the container trusts 127.0.0.1, so
# the passwords may be empty; against a managed host all three are required.
#
# psql runs inside the f1-postgres container by default (no host psql is assumed; the
# container's psql speaks TLS and resolves the internet). Override with PSQL=... .
# The protocol-rail check needs node and web/node_modules on the host.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OWNER_URL="${1:-${OWNER_URL:-postgres://f1:f1@localhost:5432/f1}}"
PSQL="${PSQL:-docker exec -i f1-postgres psql}"

# with_user URL user password  -> URL with the user info replaced (password omitted if empty)
with_user() {
  url="$1"; u="$2"; p="${3:-}"
  info="$u"; [ -n "$p" ] && info="$u:$p"
  case "$url" in
    *://*@*) printf '%s' "$url" | sed -E "s%^([a-z]+://)[^@/]*@%\1${info}@%" ;;
    *)       printf '%s' "$url" | sed -E "s%^([a-z]+://)%\1${info}@%" ;;
  esac
}
# with_db URL dbname -> URL pointing at another database on the same server
with_db() { printf '%s' "$1" | sed -E "s%^([a-z]+://[^/]+/)[^?]*%\1$2%"; }

ASK_URL="${ASK_URL:-$(with_user "$OWNER_URL" f1_ask "${ASK_PASSWORD:-}")}"
LOG_URL="${LOG_URL:-$(with_user "$OWNER_URL" f1_ask_log "${ASK_LOG_PASSWORD:-}")}"
WEB_URL="${WEB_URL:-$(with_user "$OWNER_URL" f1_web "${F1_WEB_PASSWORD:-}")}"

q() { $PSQL -X -q -tA "$@"; }   # q DSN -c '...'   (one role, one or more statements)

fail=0
pass=0
# chk LABEL WANT CMD...  — passes when every ' && '-separated substring of WANT is in the output
chk() {
  label="$1"; want="$2"; shift 2
  out="$("$@" 2>&1)" || true
  ok=1
  while IFS= read -r w; do
    printf '%s' "$out" | grep -qF -- "$w" || ok=0
  done <<< "${want// && /$'\n'}"
  if [ "$ok" -eq 1 ]; then
    pass=$((pass+1)); printf '  ok    %s\n' "$label"
  else
    fail=$((fail+1))
    printf '  FAIL  %s\n          expected substring: %s\n          got: %s\n' \
      "$label" "$want" "$(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  fi
}
# chk_err LABEL CMD...  — passes when the command fails for ANY reason (the two host-specific
# expectations of §4.2: "database postgres" may be denied or simply not exist).
chk_err() {
  label="$1"; shift
  if out="$("$@" 2>&1)"; then
    fail=$((fail+1)); printf '  FAIL  %s\n          expected an error, got: %s\n' "$label" "$(printf '%s' "$out" | head -1)"
  else
    pass=$((pass+1)); printf '  ok    %s (%s)\n' "$label" "$(printf '%s' "$out" | tail -1 | sed -E 's/.*(FATAL|ERROR)/\1/' | cut -c1-80)"
  fi
}

echo "verifying $(printf '%s' "$OWNER_URL" | sed -E 's%://[^@/]*@%://…@%')"
echo 'as f1_ask - the role that runs generated SQL'
chk 'ask.laps is readable'                  '1'   q "$ASK_URL" -c 'SELECT 1 FROM ask.laps LIMIT 1'
chk 'public.laps is denied'                 'permission denied for schema public' \
                                                  q "$ASK_URL" -c 'SELECT 1 FROM public.laps'
chk 'current_user is f1_ask, not super'     'f1_ask|f' \
    q "$ASK_URL" -c 'SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user'
chk 'no USAGE on schema public'             'f'   q "$ASK_URL" \
    -c "SELECT has_schema_privilege(current_user,'public','USAGE')"
chk 'no table grant in public at all'       '0'   q "$ASK_URL" \
    -c "SELECT count(*) FROM information_schema.table_privileges WHERE grantee = current_user AND table_schema = 'public'"
chk 'ingest_runs denied'                    'permission denied for schema public' \
                                                  q "$ASK_URL" -c 'SELECT * FROM public.ingest_runs'
chk 'ask_query_log denied'                  'permission denied for schema public' \
                                                  q "$ASK_URL" -c 'SELECT * FROM public.ask_query_log'
chk 'race_report denied'                    'permission denied for schema public' \
                                                  q "$ASK_URL" -c 'SELECT * FROM public.race_report'
chk 'INSERT into ask_query_log denied'      'permission denied for schema public' \
    q "$ASK_URL" -c "INSERT INTO public.ask_query_log (session_cookie,ip_hash,question,question_norm,validator_verdict,outcome) VALUES ('v','v','v','v','v','v')"
chk 'CREATE TABLE denied even in a READ WRITE txn' 'permission denied for schema public' \
    q "$ASK_URL" -c 'BEGIN READ WRITE; CREATE TABLE public.t_probe(i int); COMMIT'
chk 'CREATE TABLE in ask denied'            'permission denied for schema ask' \
    q "$ASK_URL" -c 'SET default_transaction_read_only=off' -c 'CREATE TABLE ask.t_probe(i int)'
chk 'CREATE SCHEMA denied'                  'permission denied for database' \
    q "$ASK_URL" -c 'SET default_transaction_read_only=off' -c 'CREATE SCHEMA evil'
chk_err 'pg_read_file denied'                     q "$ASK_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_read_file('/etc/passwd')"
chk_err 'cannot connect to database postgres'     q "$(with_db "$ASK_URL" postgres)" -v ON_ERROR_STOP=1 -c 'SELECT 1'
# The security property is that the SERVER cancels the statement, which the error text
# proves; wall clock is measured server-side over the statement so process start-up and a
# busy machine cannot fail a working rail.
sleepout="$(q "$ASK_URL" -c '\timing on' -c 'SELECT pg_sleep(10)' 2>&1 || true)"
elapsed_ms="$(printf '%s' "$sleepout" | sed -n 's/^Time: \([0-9]*\)\..*/\1/p' | tail -1)"
if printf '%s' "$sleepout" | grep -qF 'canceling statement due to statement timeout' \
   && [ -n "$elapsed_ms" ] && [ "$elapsed_ms" -le 6000 ]; then
  pass=$((pass+1)); printf '  ok    pg_sleep(10) cancelled server-side after %sms\n' "$elapsed_ms"
else
  fail=$((fail+1)); printf '  FAIL  pg_sleep(10) not cancelled server-side inside 6000ms (%sms): %s\n' "$elapsed_ms" "$sleepout"
fi

echo 'as f1_ask_log - the role that writes the query log'
chk 'current_user is f1_ask_log, not super' 'f1_ask_log|f' \
    q "$LOG_URL" -c 'SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user'
chk 'INSERT into ask_query_log succeeds'    'insert_ok' q "$LOG_URL" -v ON_ERROR_STOP=1 \
    -c "BEGIN; INSERT INTO ask_query_log (session_cookie,ip_hash,question,question_norm,validator_verdict,outcome) VALUES ('verify','verify','probe','probe','ok','verify_probe'); SELECT 'insert_ok'; ROLLBACK"
chk 'SELECT question denied (column grant)' 'permission denied for table ask_query_log' \
                                                  q "$LOG_URL" -c 'SELECT question FROM ask_query_log LIMIT 1'
chk 'SELECT * on ask_query_log denied'      'permission denied for table ask_query_log' \
                                                  q "$LOG_URL" -c 'SELECT * FROM ask_query_log LIMIT 1'
chk 'the four granted columns are readable' '0' q "$LOG_URL" \
    -c "SELECT count(*) FROM ask_query_log WHERE session_cookie = 'no_such_cookie' AND asked_at > now() AND ip_hash = '' AND estimated_cost_usd IS NULL"
chk 'DELETE from ask_query_log denied'      'permission denied for table ask_query_log' \
                                                  q "$LOG_URL" -c "DELETE FROM ask_query_log WHERE outcome = 'verify_probe'"
chk 'ask_answer_cache is read/write'        'cache_rw_ok' q "$LOG_URL" -v ON_ERROR_STOP=1 \
    -c "BEGIN; INSERT INTO ask_answer_cache (question_key,question_norm,prefix_sha256,payload) VALUES ('vp','vp','vp','{}'::jsonb); UPDATE ask_answer_cache SET hit_count = hit_count + 1 WHERE question_key = 'vp'; SELECT 'cache_rw_ok' FROM ask_answer_cache WHERE question_key = 'vp'; ROLLBACK"
chk 'F1 tables denied'                      'permission denied for table laps' \
                                                  q "$LOG_URL" -c 'SELECT count(*) FROM laps'
chk 'schema ask denied'                     'permission denied for schema ask' \
                                                  q "$LOG_URL" -c 'SELECT 1 FROM ask.laps LIMIT 1'
chk_err 'cannot connect to database postgres'     q "$(with_db "$LOG_URL" postgres)" -v ON_ERROR_STOP=1 -c 'SELECT 1'

echo 'as f1_web - the app role behind DATABASE_URL (OPS_SPEC §4.2, mandatory)'
chk 'USAGE on public, yet INSERT denied'    't && permission denied for table laps' \
    q "$WEB_URL" -c "SELECT has_schema_privilege(current_user,'public','USAGE')" \
                 -c 'BEGIN READ WRITE; INSERT INTO public.laps DEFAULT VALUES; ROLLBACK'

echo 'the rest of the cluster, as the owner'
chk 'owner role can log in and owns the database' 't|t' q "$OWNER_URL" \
    -c "SELECT r.rolcanlogin, (d.datdba = r.oid) FROM pg_roles r JOIN pg_database d ON d.datname = current_database() WHERE r.rolname = current_user"
chk 'judge_sec_probe is dropped'            '0'   q "$OWNER_URL" \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = 'judge_sec_probe'"
chk 'the four app roles: login, none super or createrole' 'f1_ask|f1_ask_log|f1_push|f1_web' q "$OWNER_URL" \
    -c "SELECT string_agg(rolname,'|' ORDER BY rolname) FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND rolname IN ('f1_ask','f1_ask_log','f1_push','f1_web')"
chk 'schema ask holds views and nothing else' 'only views: t' q "$OWNER_URL" \
    -c "SELECT (SELECT count(*) FROM pg_views WHERE schemaname='ask') || ' objects, only views: ' || ((SELECT count(*) FROM pg_views WHERE schemaname='ask') = (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ask'))"
chk 'f1_ask is granted every ask view'      'all granted: t' q "$OWNER_URL" \
    -c "SELECT 'all granted: ' || ((SELECT count(*) FROM information_schema.table_privileges WHERE grantee='f1_ask' AND table_schema='ask' AND privilege_type='SELECT') = (SELECT count(*) FROM pg_views WHERE schemaname='ask'))"
chk 'PUBLIC holds nothing anywhere that matters' '0|0|0' q "$OWNER_URL" -c \
    "SELECT (SELECT count(*) FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname=current_database() AND a.grantee=0) || '|' || (SELECT count(*) FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname='public' AND a.grantee=0) || '|' || (SELECT count(*) FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname='postgres' AND a.grantee=0)"
chk 'f1_ask has no USAGE on public; f1_push cannot read the ask log' 'f|f|f' q "$OWNER_URL" \
    -c "SELECT has_schema_privilege('f1_ask','public','USAGE'), has_table_privilege('f1_push','ask_query_log','SELECT'), has_table_privilege('f1_push','ask_answer_cache','SELECT')"

echo 'the node-postgres protocol rail (MODE3_SPEC section 1.5), against the real server'
read -r -d '' RAIL_JS <<'JS' || true
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.ASK_DATABASE_URL });
await c.connect();
let bad = 0;
const multi = "select 1; select 2";
const loose = [
  ["bare string", multi],
  ["{text}", { text: multi }],
  ["{text,values:[]}", { text: multi, values: [] }],
  ["{text,rowMode}", { text: multi, rowMode: "array" }],
  ["{text,values:[],name:undefined}", { text: multi, values: [], name: undefined }],
];
for (const [label, q] of loose) {
  const r = await c.query(q).catch((e) => e);
  const ran = Array.isArray(r) ? r.length : r instanceof Error ? 0 : 1;
  if (ran === 2) { console.log("  ok    " + label + " runs BOTH statements - the rail is needed"); }
  else { bad++; console.log("  FAIL  " + label + " did not run both (" + ran + ")"); }
}
const named = await c.query({ name: "rail_x", text: multi, values: [] }).catch((e) => e);
if (named instanceof Error && /cannot insert multiple commands/.test(named.message)) {
  console.log("  ok    {name,text,values:[]} raises: " + named.message);
} else { bad++; console.log("  FAIL  named prepared statement did not reject a multi-statement"); }
const a = await c.query({ name: "rail_e_1", text: "EXPLAIN (FORMAT JSON, COSTS ON) select 1", values: [], rowMode: "array" }).catch((e) => e);
const b = await c.query({ name: "rail_x_1", text: "select 1", values: [], rowMode: "array" }).catch((e) => e);
if (!(a instanceof Error) && !(b instanceof Error)) { console.log("  ok    two differently-named prepares of different text both succeed"); }
else { bad++; console.log("  FAIL  ask_e_/ask_x_ pair: " + (a.message || b.message)); }
await c.end();
process.exit(bad === 0 ? 0 : 1);
JS
# node connects from the host, which the container sees as a remote client, so this one
# check needs the real f1_ask password even locally (ASK_PASSWORD or a whole ASK_URL).
if railout="$(cd "$ROOT/web" && ASK_DATABASE_URL="$ASK_URL" node --input-type=module -e "$RAIL_JS" 2>&1)"; then
  printf '%s\n' "$railout"; pass=$((pass+1))
else
  printf '%s\n' "$railout" | grep -v '^    at ' | head -12; fail=$((fail+1)); echo '  FAIL  protocol rail'
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { echo 'DEPLOY BLOCKED - privilege assertions failed (MODE3_SPEC section 9 WP-2 / OPS_SPEC section 4.2)'; exit 1; }
