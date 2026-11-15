#!/usr/bin/env bash
# 下載論文公開的編輯紀錄到 data/（不進版本庫，見 .gitignore）。固定 commit，來源皆為公開資料。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
REF=7287f4bc2c054984838b3582a27b4fea8f6d8161   # josephg/eg-walker-reference
ET=762fa6c51605c88a05ebe5c4b9d4540caca30b97    # josephg/editing-traces
DT=89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922    # josephg/diamond-types
get() { [ -s "data/$2" ] || curl -fsSL "https://raw.githubusercontent.com/$1" -o "data/$2"; }
for t in ff-raw git-makefile-raw node_nodecc-raw; do get "josephg/eg-walker-reference/$REF/testdata/$t.json" "$t.json"; done
get "josephg/editing-traces/$ET/concurrent_traces/clownschool.json.gz" clownschool.json.gz
get "josephg/editing-traces/$ET/sequential_traces/automerge-paper.json.gz" automerge-paper.json.gz
get "josephg/editing-traces/$ET/sequential_traces/seph-blog1.json.gz" seph-blog1.json.gz
for t in automerge-paper seph-blog1 friendsforever clownschool git-makefile node_nodecc; do get "josephg/diamond-types/$DT/benchmark_data/$t.dt" "$t.dt"; done
ls -la data
