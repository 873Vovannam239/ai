# TalentFlow AI — Recruitment Agent PRO (Groq API)

**Next.js + NestJS + PostgreSQL + Groq (AI thật) + n8n (12 workflow, tối thiểu 7 node/luồng) + Gmail SMTP**

Bản full source đã chuyển hoàn toàn sang Groq. Không chứa `.env` hoặc API key thật. Việc gọi Groq yêu cầu **GROQ_API_KEY hợp lệ và quota**; chưa thể xác nhận trên tài khoản của bạn nếu chưa chạy trên máy bạn.

## Đã thay đổi

- `backend/src/groq.ts`: gọi `https://api.groq.com/openai/v1/chat/completions`, Bearer key, JSON mode, kiểm tra điểm số/mảng và trả lỗi thật, không tạo điểm giả.
- `backend/src/service.ts`, `backend/src/module.ts`: dùng `GroqService`; `/api/health` kiểm tra có key Groq.
- `docker-compose.yml`, `.env.example`, `start-mac.sh`: dùng `GROQ_API_KEY` và `GROQ_MODEL`.
- Nhãn ở web, workflow 02, tài liệu đã chuyển từ Gemini sang Groq. **Không đổi ID, webhook path, bảng PostgreSQL hoặc kiến trúc n8n.**

**Model mặc định:** `openai/gpt-oss-120b`. Model Llama 3.3 / 3.1 đã ngừng cho Free/Developer từ 16/08/2026; tránh dùng model ID cũ. Model có thể thay đổi theo tài khoản/quota, xem https://console.groq.com/docs/models.

## Chạy mới trên MacBook

1. Giải nén ZIP → mở Terminal tại thư mục `TalentFlow_AI_Recruitment_PRO`.
2. Nếu chưa có `.env`: `cp .env.example .env`.
3. Mở `.env` với `open -e .env`, điền các mật khẩu riêng (không để `change-me`) và `GROQ_API_KEY=gsk_...` của bạn lấy tại https://console.groq.com/keys. Đặt `GROQ_MODEL=openai/gpt-oss-120b`.
4. Mở Docker Desktop. Tại đúng thư mục project chạy `chmod +x start-mac.sh && ./start-mac.sh`.
5. Mở web http://localhost:3001, n8n http://localhost:5679. **Import 12 file** `n8n/recruitment-*.workflow.json`, sau đó Publish từng workflow cần chạy. Các file được để `active: false` có chủ đích để bạn kiểm tra secret/credentials trước khi bật.
6. Tạo công việc (JD), upload CV PDF có văn bản hoặc DOCX, xem trạng thái/điểm Groq. Dùng CV giả để demo.

> `start-mac.sh` cần Docker Desktop hoạt động, các mật khẩu và GROQ_API_KEY được thiết lập. **Không chạy `docker compose down -v`** vì lệnh đó xóa volume dữ liệu.

## Bạn đã chạy bản Gemini trước đó?

**Khuyên dùng gói `TalentFlow_Groq_PATCH.zip` đi kèm**, vì gói này chỉ cập nhật các file liên quan và tạo backup, không động vào `.env`/volume. Trong thư mục cũ đã chạy:

1. Giải nén PATCH vào Downloads; chạy script patch theo hướng dẫn trong `HUONG_DAN_PATCH_GROQ.txt`. Script sẽ từ chối sửa nếu cấu trúc thư mục không khớp.
2. Mở `.env` **của thư mục cũ** (`open -e .env`); thêm **hai dòng mới** (không cần xóa key cũ ngay):
   ```ini
   GROQ_API_KEY=gsk_xxx_key_cua_ban
   GROQ_MODEL=openai/gpt-oss-120b
   ```
3. Chạy `docker compose up -d --build api web` (không xóa container/volume database). Nếu chỉ chạy backend cũ mà không có `web`, xem lại tên service bằng `docker compose config --services`.
4. F5 lại http://localhost:3001; kiểm tra `http://localhost:4000/api/health` trả `aiConfigured: true`; tạo CV **mẫu** và phân tích lại bằng nút trong UI.
5. Nếu đã import workflow 02 và Publish thành công, **không bắt buộc import lại**: n8n gọi cùng endpoint NestJS, chỉ thay AI bên trong. Muốn nhãn mới `Groq LIVE`, Import workflow 02 mới và tránh để 2 workflow có cùng webhook path cùng Publish.

## 12 workflow theo yêu cầu nhóm 4 người

| Workflow | Điều phối n8n | Backend xử lý thật |
|---|---|---|
| 01 CV Intake | `/webhook/recruitment-cv-intake` | Kiểm tra nội dung CV; lưu xác minh |
| 02 AI Screening | `/webhook/recruitment-ai-screening` | Gọi Groq → lưu score/summary/skills/gaps |
| 03 Candidate Ranking | `/webhook/recruitment-ranking` | Thứ hạng riêng từng vị trí trong PostgreSQL |
| 04 Interview Invitation | `/webhook/recruitment-invite` | Gửi thư mời qua SMTP nếu quản trị đặt lịch |
| 05 Follow-up | Schedule hàng giờ hoặc `/webhook/recruitment-followup` | Gửi nhắc lịch đã được gửi thư mời trước đó |
| 06 Duplicate CV Check | `/webhook/recruitment-duplicate-check` | Kiểm tra hồ sơ trùng email trong cùng vị trí; backend cũng chặn tải CV trùng |
| 07 CV Normalization | `/webhook/recruitment-cv-normalize` | Chuẩn hóa xuống dòng/khoảng trắng của CV đã lưu |
| 08 Job Match Report | `/webhook/recruitment-job-match` | Lấy báo cáo đối sánh CV/JD từ kết quả Groq đã lưu |
| 09 Schedule Interview | `/webhook/recruitment-schedule-interview` | Kiểm tra dữ liệu, ngăn lịch trùng và tạo lịch; backend tiếp tục kích hoạt workflow 04 |
| 10 Recruiter Status Notification | `/webhook/recruitment-status-notify` | Gửi email nội bộ khi kết quả AI đã sẵn sàng |
| 11 Daily Recruitment Report | `/webhook/recruitment-daily-report` hoặc Schedule hằng ngày 08:00 | Tổng hợp số liệu và thử gửi báo cáo email nội bộ |
| 12 Error Monitoring | Error Trigger của n8n | Ghi lỗi vào audit log; gửi email cảnh báo khi phân loại mức `critical` |

n8n chỉ truyền ID và dữ liệu cần thiết, backend lấy CV từ DB và gửi nội dung văn bản đã che email/số điện thoại tới Groq. n8n không gọi Groq trực tiếp. Nếu workflow 02 chưa Publish, Backend có chế độ gọi Groq trực tiếp (không được nói rằng n8n đã chạy thành công).

### Chia việc 4 thành viên

Xem `docs/PHAN_CONG_4_THANH_VIEN.md` để phân chia 3 workflow/người. Xem `docs/HUONG_DAN_IMPORT_12_WORKFLOWS.md` để import, cấu hình, test và biết payload mẫu. Mỗi JSON có ít nhất 7 node; số node không thay thế việc kiểm thử logic thật.

### Cập nhật phần phỏng vấn: workflow 04, 05, 09

Đặt lịch được kiểm tra trong transaction có khóa theo ứng viên để hai yêu cầu đồng thời không tạo lịch chồng nhau. Thư đã xác nhận gửi sẽ không được gửi thêm khi webhook hoặc nút gửi lại được gọi lặp. Nhắc lịch chỉ áp dụng cho lịch còn hiệu lực, đã gửi thư mời và còn hơn 10 phút đến tối đa 24 giờ trước buổi phỏng vấn.

Nếu đang dùng database/volume cũ, áp dụng migration trước khi chạy API mới:

```bash
docker compose exec -T db psql -U recruitment -d recruitment -v ON_ERROR_STOP=1 < sql/005_interview_reliability.sql
docker compose up -d --build api web
```

Sau đó cập nhật/import lại **ba workflow 04, 05, 09**, tránh Publish hai bản cùng webhook path. Database mới dùng `sql/001_schema.sql` đã có các trường cần thiết.

Tác vụ dừng trước khi bắt đầu SMTP được phục hồi sau 3 phút khi workflow 05 chạy lại. Nếu SMTP đã bắt đầu nhưng chưa biết kết quả, trạng thái là `unknown`, cần đối soát trước khi gửi lại. Xem [hướng dẫn nghiệm thu phỏng vấn](docs/HUONG_DAN_NGHIEM_THU_PHONG_VAN.md) để kiểm thử và xử lý trạng thái này.

## Xử lý lỗi

- **AI key chưa cấu hình**: kiểm tra `.env`, `GROQ_API_KEY` và chạy `docker compose up -d --build api web`. Đảm bảo đang ở **thư mục project đúng**.
- **Groq HTTP 401/403**: key bị sai hoặc không có quyền; vào https://console.groq.com/keys.
- **Groq HTTP 404/400**: kiểm tra tên `GROQ_MODEL`, payload hoặc model được phép sử dụng.
- **Groq HTTP 429**: tài khoản đạt giới hạn requests/tokens. Backend gửi lần lượt các yêu cầu Groq, chờ theo `Retry-After` (hoặc thời gian trong thông báo lỗi) rồi thử lại, tối đa 3 lần gọi. Phân tích CV có tổng thời gian tối đa 55 giây kể cả chờ lượt, nằm trong timeout 60 giây của workflow 02; tạo nội dung phỏng vấn có tối đa 12 giây. Nếu cần chờ lâu hơn, ứng dụng báo thời gian để thử lại. Một yêu cầu vượt cả hạn mức TPM cần rút gọn CV/JD hoặc tăng hạn mức; chờ reset không giải quyết được. Xem hạn mức thực tế tại https://console.groq.com/settings/limits và tài liệu https://console.groq.com/docs/rate-limits. Không có điểm AI giả khi quota hết.
- **n8n 404 webhook**: chưa Publish hoặc path trùng với workflow cũ. **n8n 401**: cấu hình secret workflow chưa đúng.
- **Không gửi Gmail**: kiểm tra SMTP credentials, đăng nhập app password và gửi thử cho chính bạn.
- **Không nhận báo cáo/thông báo nội bộ**: đặt `RECRUITMENT_NOTIFY_EMAIL` trong `.env` (hoặc để trống để dùng `SMTP_USER`) và rebuild API bằng `docker compose up -d --build api`.

## Lưu ý quyền riêng tư

Chỉ gửi CV của người đã đồng ý và có căn cứ xử lý phù hợp. AI là công cụ hỗ trợ, có thể sai/thiên lệch; **không tự động loại hay nhận ứng viên**. Bản này là demo cục bộ, không phải hệ thống production đầy đủ. Key phải giữ trong `.env` (file bị `.gitignore` loại trừ), không chia sẻ qua chat hoặc đưa vào Git. Tham khảo `docs/KICH_BAN_DEMO.md` để thuyết trình.
