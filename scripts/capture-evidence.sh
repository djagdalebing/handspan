#!/usr/bin/env bash
# Regenerates everything under /evidence from scratch.
#
# Each scenario runs for real against the local MERIDIAN instances; nothing
# here is transcribed by hand. The runs are renamed from their generated run
# ids into readable directories so the evidence is navigable.
set -euo pipefail
cd "$(dirname "$0")/.."

export HS_SECRET_MERIDIAN_OPERATOR_ID=demo
export HS_SECRET_MERIDIAN_OPERATOR_PASSWORD=demo
MODEL_ARGS="${MODEL_ARGS:---model scripted --script scripts/member-savings-balance.script.json}"

say() { printf '\n\033[1m=== %s\033[0m\n' "$*"; }
latest() { ls -dt evidence/"$1"-* 2>/dev/null | head -1; }
keep() { # keep <prefix> <destination>
  local d; d="$(latest "$1")"
  rm -rf "evidence/$2"; mv "$d" "evidence/$2"; echo "    -> evidence/$2"
}

say "starting both tenant instances"
pkill -f "tsx target-app/server.ts" 2>/dev/null || true
sleep 1
# Disowned so that a later `wait $OP` cannot be confused by them.
npx tsx target-app/server.ts >/tmp/meridian-a.log 2>&1 & disown
TENANT=northgate PORT=4321 npx tsx target-app/server.ts >/tmp/meridian-b.log 2>&1 & disown
sleep 4

# Clear previous runs, keeping the index and the live-model run (which cannot
# be regenerated without a model key and a fresh daily quota).
mkdir -p evidence
find evidence -mindepth 1 -maxdepth 1 ! -name README.md ! -name '00-*' -exec rm -rf {} +

say "1. discovery — model drives the app and a draft capability falls out"
npx tsx src/cli.ts discover --job jobs/member-savings-balance.json $MODEL_ARGS --no-escalation
keep discover 01-discovery

say "2. review — a human promotes the draft, fixing what discovery cannot know"
npx tsx scripts/apply-review.ts

say "3. replay — deterministic, no model, typed outputs"
npx tsx src/cli.ts capability approve meridian.member.savings-balance@1.1.0 >/dev/null
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=12345 --no-escalation
keep replay 02-replay-success

say "4. replay — business outcome: no such member (an answer, not a failure)"
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=99999 --no-escalation || true
keep replay 03-replay-business-outcome

say "5. replay — recoverable condition: an unexpected acknowledgement screen"
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=12345 --fault interstitial --no-escalation
keep replay 04-replay-recovered-interstitial

say "6. replay — session expiry: re-authenticate via a nested capability, then restart"
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=12345 --fault session_expiry --no-escalation
keep replay 05-replay-session-recovered

say "7. replay — hard failure: the application itself errors"
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=12345 --fault app_error --no-escalation || true
keep replay 06-replay-app-error

say "8. replay — invalid input, rejected before the browser opens"
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=abc --no-escalation || true
keep replay 07-replay-invalid-input

say "9. escalation — operator approves an irreversible posting"
npx tsx src/cli.ts capability approve meridian.member.open-sub-account@1.0.0 >/dev/null
npx tsx scripts/operator-demo.ts --disposition resume --note "reviewed the posting details, approved" & OP=$!
npx tsx src/cli.ts replay meridian.member.open-sub-account --input memberId=12345 \
  --input accountType="VACATION CLUB" --input openingDeposit=50.00
wait $OP || true
keep replay 08-escalation-approve-irreversible

say "10. escalation — operator takes over the live session and posts it themselves"
npx tsx scripts/operator-demo.ts --takeover --note "posted manually after review" & OP=$!
npx tsx src/cli.ts replay meridian.member.open-sub-account --input memberId=23456 \
  --input accountType="HOLIDAY CLUB" --input openingDeposit=75.00
wait $OP || true
keep replay 09-escalation-human-takeover

say "11. escalation — the unreviewed draft gets stuck; operator recovers by hand"
npx tsx scripts/operator-demo.ts --disposition resume --note "signed the session back on manually" \
  --actions '[{"kind":"click","role":"textbox","name":"Operator ID"},{"kind":"text","text":"demo"},{"kind":"click","role":"textbox","name":"Password"},{"kind":"text","text":"demo"},{"kind":"click","role":"button","name":"Sign On"}]' & OP=$!
npx tsx src/cli.ts replay meridian.member.savings-balance@1.0.0 --input memberId=12345 \
  --fault session_expiry --allow-draft
wait $OP || true
keep replay 10-escalation-stuck-recovery

say "12. cross-tenant — the same capability against a second institution"
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 \
  --overlay capabilities/meridian.member.savings-balance@1.1.0.northgate.overlay.json \
  --input memberId=12345 --no-escalation
keep replay 11-cross-tenant-overlay

say "13. agent-facing catalog"
npx tsx src/cli.ts catalog --json > evidence/catalog.json
npx tsx src/cli.ts invoke meridian.member.savings-balance@1.1.0 --input memberId=23456 --no-escalation \
  | tee evidence/agent-invocation.json
keep replay 12-agent-invocation

cp capabilities/*.json evidence/ 2>/dev/null || true
pkill -f "tsx target-app/server.ts" 2>/dev/null || true
say "done — see evidence/"
