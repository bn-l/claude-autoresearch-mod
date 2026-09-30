#!/usr/bin/env bash
# Makes a throwaway git copy of examples/sort-bench for a real Claude Code run and prints
# its path. Options:
#   --no-auto          drop .auto/ (the autoresearch-create skill sets the session up)
#   --fail-checks-on=N checks.sh fails on its Nth run only (the keep gate)
#   --max=N            .auto/config.json maxIterations: the loop stops itself after N runs
#   --steer=TEXT       what .auto/hooks/before.sh tells the model before each iteration
#   --slow=N           measure.sh sleeps N seconds first (a child `sleep N` to look for)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# Outside any repository and outside the system temp folder (which the assistant's own
# tooling may refuse to touch); AR_E2E_ROOT overrides.
base=${AR_E2E_ROOT:-$HOME/.cache/autoresearch-e2e}
mkdir -p "$base"
dir=$(mktemp -d "$base/ar-cc-XXXXXX")
dir=$(cd "$dir" && pwd -P)
cp -R "$root/examples/sort-bench/." "$dir/"
for arg in "$@"; do
  case "$arg" in
    --no-auto) rm -rf "$dir/.auto" ;;
    --slow=*)
      printf '#!/bin/bash\nset -euo pipefail\nsleep %s &\nwait\nnode --check sort.js\nnode bench.js\n' "${arg#--slow=}" > "$dir/.auto/measure.sh" ;;
    --steer=*)
      printf '#!/bin/bash\ncat >/dev/null\ncat <<'"'"'STEER'"'"'\n%s\nSTEER\n' "${arg#--steer=}" > "$dir/.auto/hooks/before.sh" ;;
    --max=*) mkdir -p "$dir/.auto"; printf '{ "maxIterations": %s }\n' "${arg#--max=}" > "$dir/.auto/config.json" ;;
    --fail-checks-on=*)
      n=${arg#--fail-checks-on=}
      cat > "$dir/.auto/checks.sh" <<CHECKS
#!/bin/bash
set -euo pipefail
count=\$(( \$(cat .auto/.checks-count 2>/dev/null || echo 0) + 1 ))
echo "\$count" > .auto/.checks-count
if [ "\$count" -eq $n ]; then
  echo "FAIL: 1 of 6 cases (sort([3,1,2,3,1]) gave [1,1,3,2,3])" >&2
  exit 1
fi
node test.js
CHECKS
      chmod +x "$dir/.auto/checks.sh" ;;
    *) echo "fixture.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done
(
  cd "$dir"
  git init -q -b main
  git config user.email e2e@example.com
  git config user.name e2e
  git config commit.gpgsign false
  git add -A
  git commit -qm "sort-bench fixture"
)
echo "$dir"
