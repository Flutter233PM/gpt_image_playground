#!/bin/sh

# 用环境变量替换默认 API URL
if [ "${API_URL+x}" != "x" ]; then
  if [ -n "${API_PROXY_URL:-}" ]; then
    API_URL=same-origin
  else
    API_URL=https://api.openai.com
  fi
fi

if [ -n "${API_PROXY_URL:-}" ]; then
  API_PROXY_URL=$(printf '%s' "$API_PROXY_URL" | sed 's|/*$||')
  API_PROXY_TIMEOUT=${API_PROXY_TIMEOUT:-600s}
  API_PROXY_CONNECT_TIMEOUT=${API_PROXY_CONNECT_TIMEOUT:-60s}
  API_PROXY_MAX_BODY_SIZE=${API_PROXY_MAX_BODY_SIZE:-256m}
  cat >/etc/nginx/api-proxy-location.conf <<EOF
    location /v1/ {
        client_max_body_size ${API_PROXY_MAX_BODY_SIZE};
        set \$proxy_authorization \$http_authorization;
        set \$proxy_connection "";
        set \$proxy_origin \$http_origin;
        set \$proxy_ws_protocol "";
        if (\$http_sec_websocket_protocol ~* "(^|,)[[:space:]]*sub2api-api-key\\.([^,[:space:]]+)") {
            set \$proxy_authorization "Bearer \$2";
        }
        if (\$http_upgrade != "") {
            set \$proxy_connection "upgrade";
            set \$proxy_origin "${API_PROXY_URL}";
            set \$proxy_ws_protocol "sub2api.responses.v2";
        }
        proxy_pass ${API_PROXY_URL}/v1/;
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_connect_timeout ${API_PROXY_CONNECT_TIMEOUT};
        proxy_send_timeout ${API_PROXY_TIMEOUT};
        proxy_read_timeout ${API_PROXY_TIMEOUT};
        send_timeout ${API_PROXY_TIMEOUT};
        proxy_set_header Host \$proxy_host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$proxy_connection;
        proxy_set_header Origin \$proxy_origin;
        proxy_set_header Authorization \$proxy_authorization;
        proxy_set_header Sec-WebSocket-Protocol "";
        add_header Sec-WebSocket-Protocol \$proxy_ws_protocol always;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
EOF
else
  : >/etc/nginx/api-proxy-location.conf
fi

# 查找所有 js 文件并将占位符替换为实际的 API_URL
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$API_URL|g" {} +

exec "$@"
