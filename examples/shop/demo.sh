#!/bin/sh
# Three minutes of Graph-Warden: one graph, several people, as many views, every read audited.
# Run from anywhere, after `docker compose --profile demo up -d --build --wait` at the repository root.
# Needs only Docker: every command runs the gwarden CLI in the demo image, against the demo API.
set -eu
cd "$(dirname "$0")/../.."

token() { grep -B1 "  user: $1\$" examples/shop/users.yaml | head -1 | sed 's/.*token: //'; }
groups() { grep -A1 "  user: $1\$" examples/shop/users.yaml | tail -1 | sed 's/.*teams: //'; }
# gwarden as a user: the API decides what they see from their token alone.
as() {
  who=$1
  shift
  docker compose --profile demo run --rm --no-deps -e GWARDEN_API=http://api:8080 -e GWARDEN_TOKEN="$(token "$who")" \
    api sh -c "$*" 2>&1 | grep -v -E '^ ?(Container|Network|Volume) '
}
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. Who touches GET /orders? One graph, one question, four people."
for who in bob alice carla lea; do
  printf '\n%s %s\n' "$who" "$(groups "$who")"
  as "$who" gwarden traverse orders-api --direction both --depth 2
done

say "2. The leads' impact summary was declared shared, but it is derived from BFF, front-a and front-b"
echo "   documents. Ingestion narrowed it to teams:bff,front-a,front-b. Bob is only in bff:"
as bob gwarden traverse pagination-impact
echo "   Lea is in dev-leads, nested in every team group by the directory:"
as lea gwarden traverse pagination-impact

say "3. Alice pulls her part of the graph into a local cache: no inbound port, nothing she may not see."
as alice "gwarden pull --cache /tmp/cache.db && gwarden cache --cache /tmp/cache.db"

say "4. An endpoint is a contract between teams. Shopping-Front renamed a clickstream event, Data's funnel broke."
echo "   Marie (Shopping-Front) sees who sends the events and the contract ADR she wrote with Data:"
as marie gwarden traverse clickstream-events --direction in --depth 2
echo "   Sofia (Data) sees her incident and its fix, not the release behind it, a Shopping-Front document:"
as sofia gwarden traverse incident-208 --direction both --depth 1
echo "   Lea sees the whole chain: release 2026.42 causes INC-208, ADR 0003 fixes it."
as lea gwarden traverse incident-208 --direction both --depth 1

say "5. Profile v2 breaks Shopping-Front and Data. Its impact summary is derived from all three teams:"
echo "   Yanis, who wrote ADR 0012, is only in user and does not get it:"
as yanis gwarden traverse profile-v2-impact --depth 1
echo "   Lea does, and its sources:"
as lea gwarden traverse profile-v2-impact --depth 1

say "6. Who read what. Only auditors may read the audit log; Bob may not:"
as bob gwarden audit || true
echo "   The DPO may, and that read is recorded too:"
as dpo gwarden audit
