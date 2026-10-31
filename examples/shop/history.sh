#!/bin/sh
# Gives the demo repository a history (issue #16): examples/shop/repo as three commits, in a
# repository at $1/origin and the clone the API reads at $1/shop, as the worker would keep it.
# Run by the demo's seed service; again, it starts over.
set -eu
src=$(cd "$(dirname "$0")/repo" && pwd)
dest=$1
rm -rf "$dest/origin" "$dest/shop"
mkdir -p "$dest/origin"
cd "$dest/origin"
git init -q -b main
git() { command git -c user.name="Shop CI" -c user.email=ci@shop.example "$@"; }

# 1. The BFF and the web fronts, orders paged by offset, no recommendations yet.
cp -R "$src/." .
rm -rf apps/front-c apps/bff/src/routes/recommendations.ts
sed -i -e '/^  \/recommendations:/,$d' -e 's/paginated by cursor (ADR 0007)/paginated by offset/' apps/bff/openapi.yaml
git add -A
git commit -q -m "Shop BFF: orders, refunds and profile" -m "Orders are paged by offset."

# 2. The mobile home screen, with recommendations.
cp -R "$src/apps/front-c" apps/
cp "$src/apps/bff/src/routes/recommendations.ts" apps/bff/src/routes/
sed -n '/^  \/recommendations:/,$p' "$src/apps/bff/openapi.yaml" >>apps/bff/openapi.yaml
git add -A
git commit -q -m "Recommendations on the mobile home screen"

# 3. Orders paged by cursor: the change ADR 0007 decided, which every front listing orders reads.
cp "$src/apps/bff/openapi.yaml" apps/bff/openapi.yaml
git add -A
git commit -q -m "Page orders by cursor (ADR 0007)" -m "GET /orders takes a cursor instead of an offset."

command git clone -q "$dest/origin" "$dest/shop"
command git -C "$dest/shop" log --oneline
