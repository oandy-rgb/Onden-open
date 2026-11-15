#!/usr/bin/env bash
# Bring the two other ways to run Onden up to a commit: the browser version (https://onden.o-andy.com, a Cloudflare
# Worker with static assets named onden-trial) and the desktop app on this laptop (~/Applications). Run on the laptop.
# scripts/deploy-vps.sh switch runs this after prod is on the commit, so the three never drift apart again.
#
#   scripts/deploy-clients.sh <commit>            both
#   scripts/deploy-clients.sh <commit> browser    only the browser version
#   scripts/deploy-clients.sh <commit> desktop    only the desktop app
#   scripts/deploy-clients.sh status              what each one is on
#
# It builds in its own checkout ($ONDEN_CLIENTS_DIR, default ../Onden-clients-build next to the repo), never in the
# working tree it is run from: what goes out is the commit, not whatever is checked out or half-edited here.
# Both builds are heavy (the frontend build twice, ~3 GB): one run at a time, and not while a full test suite runs.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${ONDEN_CLIENTS_DIR:-$(dirname "$REPO")/Onden-clients-build}
SITE=${ONDEN_BROWSER_URL:-https://onden.o-andy.com}
SITE_NAME=${ONDEN_BROWSER_WORKER:-onden-trial}
APPS=${ONDEN_DESKTOP_DIR:-$HOME/Applications}

die() { echo "deploy-clients: $*" >&2; exit 1; }
live_build() { curl -fsS -m 20 "$SITE/build.json" 2> /dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).build??"")}catch{console.log("")}})'; }

status() {
  echo "browser version ($SITE): $(live_build | grep . || echo 'no build id (older than build.json, or unreachable)')"
  echo "desktop app ($APPS): $(cat "$APPS/Onden.build" 2> /dev/null || echo 'no record')"
}

checkout() {
  git -C "$REPO" fetch -q origin
  sha=$(git -C "$REPO" rev-parse --verify "$target^{commit}") || die "no commit $target"
  if [ ! -e "$WORK/.git" ]; then git -C "$REPO" worktree add -q --detach "$WORK" "$sha"; fi
  git -C "$WORK" checkout -q --detach "$sha"
  rm -rf "$WORK/packages/desktop/release"
  # npm ci only when the lockfile moved: it is the slow part of a build that otherwise takes minutes.
  lock=$(sha1sum < "$WORK/package-lock.json" | cut -c1-16)
  if [ "$(cat "$WORK/node_modules/.clients-lock" 2> /dev/null)" != "$lock" ]; then
    echo "== npm ci"
    (cd "$WORK" && npm ci --no-audit --no-fund > "$WORK/.clients-npm.log" 2>&1) || { tail -20 "$WORK/.clients-npm.log"; die "npm ci failed"; }
    echo "$lock" > "$WORK/node_modules/.clients-lock"
  fi
}

browser() {
  echo "== browser version at ${sha:0:8}"
  out=$WORK/.clients-site
  rm -rf "$out"; mkdir -p "$out"
  (cd "$WORK" && ONDEN_BUILD_ID=$sha node scripts/build-browser.mjs --tag="${sha:0:8}" > "$WORK/.clients-browser.log" 2>&1) || { tail -30 "$WORK/.clients-browser.log"; die "browser build failed"; }
  # deploy-browser.mjs runs the pre-publish scan (keys, internal addresses, machine paths) and stops on a finding.
  (cd "$WORK" && node scripts/deploy-browser.mjs --to "$out/public") || die "the pre-publish scan stopped the browser version"
  printf 'User-agent: *\nDisallow: /\n' > "$out/public/robots.txt"
  printf '/*\n  X-Robots-Tag: noindex, nofollow\n/*.wasm\n  Content-Type: application/wasm\n' > "$out/public/_headers"
  (cd "$WORK" && npm ls --omit=dev --all --parseable 2> /dev/null) | node -e '
    const fs = require("fs"), seen = new Set(), rows = [];
    for (const dir of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
      try {
        const p = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
        const key = p.name + "@" + p.version;
        if (!p.name || p.private || seen.has(key)) continue;
        seen.add(key); rows.push(key + "  " + (typeof p.license === "string" ? p.license : p.license?.type ?? "see package"));
      } catch {}
    }
    console.log("Third-party packages in this build\n\n" + rows.sort().join("\n"));' > "$out/public/THIRD_PARTY_LICENSES.txt"
  # The Worker settings sit beside the asset folder, never inside it: a file in there is served to everyone.
  cat > "$out/wrangler.jsonc" <<JSON
{ "name": "$SITE_NAME", "compatibility_date": "2026-11-01",
  "assets": { "directory": "./public", "not_found_handling": "single-page-application" },
  "routes": [{ "pattern": "${SITE#https://}", "custom_domain": true }] }
JSON
  (cd "$out" && npx --yes wrangler@4 deploy > "$WORK/.clients-wrangler.log" 2>&1) || { tail -20 "$WORK/.clients-wrangler.log"; die "upload of the browser version failed (npx wrangler login?)"; }
  # The edge can take over half a minute to serve the new build.json (seen 2026-11-13: the check failed, the next read was right).
  for _ in $(seq 24); do [ "$(live_build)" = "$sha" ] && break; sleep 5; done
  [ "$(live_build)" = "$sha" ] || die "$SITE/build.json is '$(live_build)', want $sha"
  echo "browser version: $SITE is on ${sha:0:8}"
}

desktop() {
  echo "== desktop app at ${sha:0:8}"
  (cd "$WORK" && npm ci --prefix packages/desktop --no-audit --no-fund && ONDEN_BUILD_ID=$sha npm run build --prefix packages/desktop) > "$WORK/.clients-desktop.log" 2>&1 \
    || { tail -30 "$WORK/.clients-desktop.log"; die "desktop build failed"; }
  built=$(ls -t "$WORK"/packages/desktop/release/Onden-*.AppImage 2> /dev/null | head -1)
  [ -n "$built" ] || die "the desktop build left no AppImage"
  mkdir -p "$APPS"
  # Onto the same name by rename: a running copy keeps its old file open and the next launch gets the new one.
  cp "$built" "$APPS/.$(basename "$built").part" && chmod +x "$APPS/.$(basename "$built").part" && mv -f "$APPS/.$(basename "$built").part" "$APPS/$(basename "$built")"
  echo "$sha" > "$APPS/Onden.build"
  echo "desktop app: $APPS/$(basename "$built") is on ${sha:0:8} (takes effect the next time it is opened)"
}

target=${1:-}; shift || true
[ -n "$target" ] || die "needs a commit, or: status"
if [ "$target" = status ]; then status; exit 0; fi
parts=${*:-browser desktop}
for p in $parts; do case "$p" in browser | desktop) ;; *) die "unknown part $p" ;; esac; done

exec 9> "$(dirname "$WORK")/.onden-clients.lock"
flock -n 9 || die "another deploy-clients run is in progress"
checkout
failed=""
for p in $parts; do ( "$p" ) || failed="$failed $p"; done
[ -z "$failed" ] || die "not updated:$failed — rerun: scripts/deploy-clients.sh ${sha:0:12}$failed"
