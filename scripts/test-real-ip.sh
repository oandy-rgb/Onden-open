#!/usr/bin/env bash
# 端到端驗證：經過 nginx（與選用的 Caddy）後，後端看到的是真實客戶端 IP，
# 客戶端自己送的 X-Real-IP / X-Forwarded-For 改不了它。需要 Docker；不碰你的 compose 專案。
# 用法：scripts/test-real-ip.sh
set -euo pipefail
cd "$(dirname "$0")/.."
N=onden-realip-$$
cleanup() { docker rm -f "$N-echo" "$N-nginx" "$N-caddy" >/dev/null 2>&1 || true; docker network rm "$N" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
TMP=$(mktemp -d); trap cleanup EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "✓ $1"; else echo "✗ $1（要 $3，實得 $2）"; fail=1; fi; }

docker network create "$N" >/dev/null
# 假後端與假前端（都叫 backend／frontend 這兩個名字給 nginx 解析）：回傳收到的 X-Real-IP 與 X-Forwarded-For。
cat > "$TMP/echo.conf" <<'C'
server { listen 8787; listen 80;
  location / { default_type text/plain; return 200 "real=$http_x_real_ip xff=$http_x_forwarded_for"; } }
C
docker run -d --name "$N-echo" --network "$N" --network-alias backend --network-alias frontend \
  -v "$TMP/echo.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.31-alpine >/dev/null
docker run -d --name "$N-nginx" --network "$N" -v "$PWD/docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:1.31-alpine >/dev/null
sleep 2
docker exec "$N-nginx" nginx -t

# 1) 不經 Caddy：直接打 80，偽造的標頭被覆寫成連線來源。
src=$(docker run --rm --network "$N" curlimages/curl -s -H 'X-Real-IP: 6.6.6.6' -H 'X-Forwarded-For: 7.7.7.7' "http://$N-nginx/api/x")
real_src=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$N\").IPAddress}}" "$N-nginx")
echo "  nginx:80 → $src"
case "$src" in *6.6.6.6*|*7.7.7.7*) check "port 80 不信任客戶端標頭" bad ok;; *) check "port 80 不信任客戶端標頭" ok ok;; esac
check "port 80 以連線來源為準" "$(echo "$src" | grep -c 'real=172\.\|real=10\.\|real=192\.168\.')" 1

# 2) 經 Caddy（本機自簽 localhost）：後端看到瀏覽器（此處 = 發請求的容器）的 IP，偽造無效。
cat > "$TMP/Caddyfile" <<C
{ local_certs }
localhost { reverse_proxy nginx:8081 { header_up X-Real-IP {remote_host}
  header_up X-Forwarded-For {remote_host} } }
C
docker run -d --name "$N-caddy" --network "$N" --network-alias nginx -v "$TMP/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10-alpine >/dev/null
# nginx 容器要有 "nginx" 這個別名給 Caddy 用：重新接上網路。
docker network disconnect "$N" "$N-nginx"; docker network connect --alias nginx "$N" "$N-nginx"
sleep 4
CLIENT_IP=$(docker run --rm --network "$N" curlimages/curl sh -c "hostname -i")
via=$(docker run --rm --network "$N" --add-host localhost:$(docker inspect -f "{{(index .NetworkSettings.Networks \"$N\").IPAddress}}" "$N-caddy") \
  curlimages/curl -sk -H 'X-Real-IP: 6.6.6.6' -H 'X-Forwarded-For: 7.7.7.7' https://localhost/api/x)
echo "  caddy → $via"
case "$via" in *6.6.6.6*|*7.7.7.7*) check "經 Caddy 偽造標頭無效" bad ok;; *) check "經 Caddy 偽造標頭無效" ok ok;; esac
check "經 Caddy 後端看到 Caddy 看到的客戶端位址" "$(echo "$via" | grep -c 'real=172\.\|real=10\.\|real=192\.168\.')" 1

# 3) 客戶端若直接對 nginx:80 送 X-Real-IP，不能冒用 8081 的信任。
spoof=$(docker run --rm --network "$N" curlimages/curl -s -H 'X-Real-IP: 6.6.6.6' "http://$N-nginx:80/api/x")
case "$spoof" in *6.6.6.6*) check "80 埠不接受 X-Real-IP" bad ok;; *) check "80 埠不接受 X-Real-IP" ok ok;; esac
exit $fail
