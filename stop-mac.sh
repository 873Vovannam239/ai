#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v docker >/dev/null && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
docker compose down
printf 'Đã dừng containers; dữ liệu PostgreSQL & n8n vẫn được giữ trong Docker volumes.\n'
