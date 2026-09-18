#!/usr/bin/env bash
# Resume the qualifying cache warm after a FastF1 rate-limit stop (500 calls/hour).
# Re-running warm_cache.py is safe and cheap: anything already cached is read from disk
# and costs no API call, so this only fetches what is still missing. Loop until a full
# pass reports no RateLimitExceededError, sleeping an hour between attempts.
set -u
cd "$(dirname "$0")/.."
for attempt in 1 2 3 4 5; do
  echo "=== attempt $attempt at $(date '+%H:%M:%S')"
  ./.venv/bin/python scripts/warm_cache.py --quali 2024 2025 2026 > output/warm_quali_resume.log 2>&1
  n=$(grep -c "RateLimitExceededError" output/warm_quali_resume.log || true)
  echo "    rate-limited sessions this pass: $n"
  [ "$n" -eq 0 ] && { echo "COMPLETE — nothing left to fetch"; exit 0; }
  echo "    sleeping 3660s for the hourly window to reset"
  sleep 3660
done
echo "STOPPED after 5 attempts; $n sessions still uncached"
