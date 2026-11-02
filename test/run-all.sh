#!/usr/bin/env bash
# Draait alle websitetests: eerst de pure Node-unittests, daarna de browsertests (Playwright).
#
# Alleen testen: dit script schrijft niets buiten /tmp, deployt niets en heeft geen geheimen nodig.
# Elke browsertest verwacht een eigen lokale poort (zie de kop van elk bestand); die wordt hier per test gestart.
#
# Vereist voor de browsertests (de workflow .github/workflows/web-tests.yml zorgt hiervoor):
#   - 'playwright' vindbaar voor Node (NODE_PATH) en een Chromium (MJOP_CHROMIUM = pad naar het programma)
#   - MJOP_SUPABASE_SDK = pad naar dist/umd/supabase.js uit @supabase/supabase-js@2.116.0 (dezelfde versie als index.html)
#
# Gebruik:  bash test/run-all.sh            (alles)
#           bash test/run-all.sh unit       (alleen Node-unittests, geen browser nodig)
set -u
cd "$(dirname "$0")/.."

MODE="${1:-all}"
TIMEOUT="${MJOP_SPEC_TIMEOUT:-180}"
fails=()
passes=0
lines=()

record() { # naam status detail
  lines+=("| $1 | $2 | $3 |")
  if [ "$2" = "OK" ]; then passes=$((passes + 1)); else fails+=("$1"); fi
}

# Telt 'OK'/'FOUT'-regels in de uitvoer van een spec (de specs gebruiken beide conventies).
count() { printf '%s\n' "$1" | grep -cE "$2" || true; }

run_spec() { # bestand poort|-
  local f="$1" port="$2" srv="" out rc ok bad
  if [ "$port" != "-" ]; then
    python3 -m http.server "$port" >/dev/null 2>&1 &
    srv=$!
    sleep 1
  fi
  out=$(timeout "$TIMEOUT" node "$f" 2>&1)
  rc=$?
  [ -n "$srv" ] && kill "$srv" 2>/dev/null && wait "$srv" 2>/dev/null
  ok=$(count "$out" '^(OK|ok|PASS)')
  bad=$(count "$out" '^(FOUT|FAIL|not ok)')
  echo "::group::$f (rc=$rc, ok=$ok, fout=$bad)"
  printf '%s\n' "$out" | tail -40
  echo "::endgroup::"
  if [ "$rc" -eq 0 ] && [ "$bad" -eq 0 ]; then record "$f" OK "$ok controles"; else record "$f" FOUT "rc=$rc, $bad mislukt"; fi
}

for f in test/*.unit.spec.js; do
  run_spec "$f" -
done

if [ "$MODE" != "unit" ]; then
  for f in test/*.spec.js; do
    case "$f" in *.unit.spec.js) continue ;; esac
    port=$(grep -oE 'localhost:[0-9]{4}' "$f" | head -1 | cut -d: -f2)
    run_spec "$f" "${port:-8937}"
  done
fi

summary() {
  echo "## Websitetests"
  echo
  echo "| Bestand | Uitkomst | Detail |"
  echo "|---|---|---|"
  printf '%s\n' "${lines[@]}"
  echo
  echo "Geslaagd: $passes — Mislukt: ${#fails[@]}"
}
summary
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then summary >> "$GITHUB_STEP_SUMMARY"; fi

if [ "${#fails[@]}" -gt 0 ]; then
  echo "Mislukt: ${fails[*]}"
  exit 1
fi
