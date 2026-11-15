#!/usr/bin/env bash
# 產生一個版本的發布說明（Markdown）：自上一個 tag 以來合併的 PR 標題，
# 以及新增的 migration。GitHub Actions 與 scripts/release.sh 共用這一份，
# CHANGELOG.md 的每一節就是這支腳本的輸出。
#
# 用法：scripts/changelog.sh <版本> [--since <tag>] [--until <ref>] [--update]
#   <版本>     例如 v0.2.0（只用來當標題；不要求 tag 已存在）
#   --since    起點 tag；預設是 <版本> 以外最近的 v* tag，沒有就從頭算
#   --until    終點 ref；預設 HEAD
#   --update   把這一節插到 CHANGELOG.md 最上面（已有同版本標題就取代）；
#              不加就只印到標準輸出
set -euo pipefail

version="" since="" until_ref="HEAD" update=0
while [ $# -gt 0 ]; do
  case "$1" in
    --since) since="${2:?--since 需要 tag}"; shift 2 ;;
    --until) until_ref="${2:?--until 需要 ref}"; shift 2 ;;
    --update) update=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "未知參數：$1" >&2; exit 2 ;;
    *) version="$1"; shift ;;
  esac
done
[ -n "$version" ] || { echo "用法：scripts/changelog.sh <版本> [--since <tag>] [--until <ref>] [--update]" >&2; exit 2; }

cd "$(git rev-parse --show-toplevel)"

if [ -z "$since" ]; then
  since=$(git tag --list 'v*' --sort=-v:refname --merged "$until_ref" | grep -vx "$version" | head -n 1 || true)
fi
range="$until_ref"
[ -n "$since" ] && range="$since..$until_ref"

# Merge commit：標題在內文第一行（"Merge pull request #N from …"）；
# squash：標題結尾 "(#N)"。其餘 merge（同步 main 等）略過。
prs=$(git log --first-parent --format='%H%x1f%s%x1f%b%x1e' "$range" | awk -v RS='\036' -F'\037' '
  { gsub(/^\n+/, "", $1) }
  $2 ~ /^Merge pull request #[0-9]+ / {
    n = $2; sub(/^Merge pull request #/, "", n); sub(/ .*/, "", n)
    t = $3; sub(/\n.*/, "", t)
    if (t != "") print "- " t " (#" n ")"
    next
  }
  $2 ~ /\(#[0-9]+\)$/ { print "- " $2 }
')

migrations=$(git diff --name-only --diff-filter=A ${since:+"$since"} "$until_ref" -- 'packages/backend/db/migrations/*.sql' 2>/dev/null | sort || true)

section=$(
  echo "## $version - $(date -u +%Y-%m-%d)"
  echo
  if [ -n "$migrations" ]; then
    echo "### 資料庫 migration（升級時由 backend 開機自動套用）"
    echo
    echo "$migrations" | sed -e 's#.*/##' -e 's#^#- `&#' -e 's#$#`#'
    echo
  fi
  echo "### 變更"
  echo
  if [ -n "$prs" ]; then echo "$prs"; else echo "- （自 ${since:-最初} 以來沒有合併的 PR）"; fi
  echo
  echo "### 需要手動處理"
  echo
  echo "- （發布前人工填寫；沒有就寫「無」）"
)

if [ "$update" -eq 0 ]; then
  printf '%s\n' "$section"
  exit 0
fi

file=CHANGELOG.md
header=$'# 更新紀錄\n\n每一節由 `scripts/changelog.sh` 產生，發布前人工補上「需要手動處理」。規則見 docs/agents/release.md。\n'
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
body=""
if [ -f "$file" ]; then
  # 去掉檔頭與同版本的舊節，保留其餘版本
  body=$(awk -v v="## $version - " '
    /^## / { skip = (index($0, v) == 1) }
    /^## / || seen { seen = 1 }
    seen && !skip { print }
  ' "$file")
fi
{ printf '%s\n' "$header"; printf '%s\n' "$section"; [ -n "$body" ] && { echo; printf '%s\n' "$body"; }; } > "$tmp"
mv "$tmp" "$file"
trap - EXIT
echo "已更新 $file（$version）" >&2
