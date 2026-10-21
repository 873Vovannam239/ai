#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v docker >/dev/null && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
if ! command -v docker >/dev/null; then
  echo 'Không tìm thấy docker. Hãy cài Docker Desktop cho Mac trước.'; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Docker chưa chạy. Hãy mở Docker Desktop, đợi Docker Engine chạy rồi thử lại.'; exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo 'Đã tạo .env từ .env.example. Hãy mở file .env và thêm GROQ_API_KEY, Gmail SMTP và đổi các mật khẩu.'
  echo 'Sau đó chạy lại: ./start-mac.sh'
  exit 0
fi
if ! grep -q '^GROQ_API_KEY=.' .env; then
  echo 'Bạn chưa nhập GROQ_API_KEY trong .env. Dự án không dùng AI giả lập.'
  exit 1
fi
docker compose up -d --build
echo ''
echo 'Giao diện Next.js: http://localhost:3001'
echo 'n8n: http://localhost:5679'
echo 'API health: http://localhost:4000/api/health'
echo 'BẮT BUỘC: import đủ 12 file n8n/recruitment-*.workflow.json rồi Publish/Activate từng workflow.'
