#!/usr/bin/env bash
# 在本機用 docker buildx 建多架構映像並推到 GHCR。GitHub Actions 不能用時的備案；
# 流程與 .github/workflows/release.yml 等價（同樣的映像、tag、build 參數）。
#
# 用法：scripts/release.sh <版本> [--dry-run] [--no-latest] [--platforms linux/amd64,linux/arm64]
#   <版本>        v0.1.0 這種格式（有 -rc.1 之類後綴的預發布不會更新 latest）
#   --dry-run     只印出會執行的指令與檢查結果，不建置也不推送
#   --no-latest   不更新 latest（例如補發舊版本）
#   --platforms   預設 linux/amd64,linux/arm64
#
# 推送前自己先登入：echo "$GHCR_TOKEN" | docker login ghcr.io -u <帳號> --password-stdin
# （token 需要 write:packages）。這支腳本不處理、也不儲存任何憑證。
# 它不建立 git tag；映像推完後依畫面提示自己打 tag（規則見 docs/agents/release.md）。
set -euo pipefail

REGISTRY="ghcr.io/oandy-rgb"
SOURCE_URL="https://github.com/oandy-rgb/onden"
platforms="linux/amd64,linux/arm64"
dry=0 latest=1 version=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --no-latest) latest=0; shift ;;
    --platforms) platforms="${2:?--platforms 需要值}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    -*) echo "未知參數：$1" >&2; exit 2 ;;
    *) version="$1"; shift ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }

[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] \
  || die "版本格式要像 v0.1.0（收到：${version:-空}）。用法：scripts/release.sh <版本>"
# 預發布（含 -）不當作最新發布版本
[[ "$version" == *-* ]] && latest=0

cd "$(git rev-parse --show-toplevel)"

command -v docker >/dev/null || die "找不到 docker。"
docker buildx version >/dev/null 2>&1 || die "找不到 docker buildx（安裝 docker-buildx 外掛）。"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "工作目錄有未提交的修改；映像要對應一個確定的 commit。先提交或 stash。"
fi
revision=$(git rev-parse HEAD)
if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
  [ "$(git rev-parse "$version^{commit}")" = "$revision" ] \
    || die "tag $version 已存在但不在目前 commit；先 git checkout $version 再執行。"
fi
git fetch -q origin main 2>/dev/null || echo "! 無法 fetch origin/main，略過「是否來自 main」檢查" >&2
if git rev-parse -q --verify origin/main >/dev/null && ! git merge-base --is-ancestor "$revision" origin/main; then
  echo "! 目前 commit 不在 origin/main 上；發布版本應該從 main 切出。" >&2
fi

# GHCR 登入檢查（只讀本機 docker 設定；看不出來就放行，推送失敗時再提示）
logged_in() {
  local cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  [ -f "$cfg" ] || return 1
  grep -q '"ghcr.io"' "$cfg" && return 0
  local store
  store=$(sed -n 's/.*"credsStore"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -n 1)
  if [ -n "$store" ] && command -v "docker-credential-$store" >/dev/null; then
    "docker-credential-$store" list 2>/dev/null | grep -q 'ghcr.io' && return 0
    return 1
  fi
  return 1
}
login_hint() {
  cat >&2 <<HINT
✗ 尚未登入 ghcr.io，無法推送映像。請先自己登入（token 需要 write:packages）：
    echo "\$GHCR_TOKEN" | docker login ghcr.io -u <GitHub 帳號> --password-stdin
  登入後重新執行 scripts/release.sh $version
HINT
}
if [ "$dry" -eq 0 ] && ! logged_in; then login_hint; exit 1; fi

# 多架構需要 docker-container driver 的 builder（預設 docker driver 不能一次建多平台）
builder=onden-release
if [ "$dry" -eq 0 ]; then
  docker buildx inspect "$builder" >/dev/null 2>&1 \
    || docker buildx create --name "$builder" --driver docker-container >/dev/null
  if ! docker buildx inspect "$builder" --bootstrap | grep -q 'linux/arm64'; then
    echo "! 這台機器看不到 linux/arm64 模擬。若要建 arm64，先執行：" >&2
    echo "    docker run --privileged --rm tonistiigi/binfmt --install all" >&2
  fi
fi

run() {
  if [ "$dry" -eq 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

build_image() { # <名稱> <context> <Dockerfile> [額外 build 參數…]
  local name="$1" context="$2" dockerfile="$3"; shift 3
  local image="$REGISTRY/onden-$name"
  local tags=(--tag "$image:$version")
  [ "$latest" -eq 1 ] && tags+=(--tag "$image:latest")
  echo "== onden-$name $version ($platforms)" >&2
  run docker buildx build --builder "$builder" \
    --platform "$platforms" \
    --file "$dockerfile" \
    "${tags[@]}" \
    --label "org.opencontainers.image.source=$SOURCE_URL" \
    --label "org.opencontainers.image.version=$version" \
    --label "org.opencontainers.image.revision=$revision" \
    "$@" \
    --push "$context" || {
      [ "$dry" -eq 0 ] && ! logged_in && login_hint
      die "onden-$name 建置或推送失敗。"
    }
}

# ONDEN_BUILD_ID = 版本字串，前後端一致：backend 用 X-Onden-Build 回報，
# 與頁面 build 不同就提示重新載入。frontend 的 API base 與 compose 一致為空字串。
build_image postgres docker/postgres docker/postgres/Dockerfile
build_image backend . packages/backend/docker/Dockerfile --build-arg "ONDEN_BUILD_ID=$version"
build_image frontend . packages/frontend/docker/Dockerfile \
  --build-arg "ONDEN_BUILD_ID=$version" --build-arg "PUBLIC_API_BASE_URL="

note=""; [ "$dry" -eq 1 ] && note="（dry-run：未實際）"
cat >&2 <<DONE

✓ 三個映像已推送${note}：$REGISTRY/onden-{postgres,backend,frontend}:$version$( [ "$latest" -eq 1 ] && echo " 與 latest" )
接下來（規則見 docs/agents/release.md）：
  1. scripts/changelog.sh $version --update   # 更新 CHANGELOG.md，補上「需要手動處理」，經 PR 合併
  2. git tag -a $version $revision -m "$version" && git push origin $version
     （Actions 恢復後，推 tag 會再跑一次 release.yml 重建同版本映像並建立 GitHub release；
      Actions 仍停用時，到 GitHub 手動建立 release 並貼上 changelog 該節）
  3. 第一次推送的 GHCR 套件預設是私有：到 GitHub ▸ Packages ▸ 各映像 ▸ Package settings 改成 Public，
     自架的人才能不登入 pull。
DONE
