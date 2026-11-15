#!/usr/bin/env bash
# 記憶體探測：每個 case 一個全新程序；輸出 out/mem.json（JSON 陣列）
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p out
: > out/mem.jsonl
probe() { node --expose-gc --max-semi-space-size=2048 --import tsx src/memProbe.ts "$1" "$2" >> out/mem.jsonl 2>/dev/null || echo "{\"impl\":\"$1\",\"spec\":\"$2\",\"skipped\":true}" >> out/mem.jsonl; }
for sc in 10KB-100 10KB-1000 50KB-1000 200KB-100 200KB-1000; do
  for impl in diff3 ref dt proto; do probe $impl "fork:$sc:a"; done
done
for t in friendsforever clownschool node_nodecc git-makefile automerge-paper; do
  for impl in dt proto; do probe $impl "trace:$t:b"; done
done
probe ref "trace:friendsforever:b"
node -e "const fs=require('fs');fs.writeFileSync('out/mem.json',JSON.stringify(fs.readFileSync('out/mem.jsonl','utf8').trim().split('\n').map(JSON.parse),null,1))"
echo done
