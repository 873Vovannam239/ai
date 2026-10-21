# Hướng dẫn import, cấu hình và test 12 workflow n8n

## 1. Chuẩn bị

1. Mở Docker Desktop.
2. Trong Terminal, vào thư mục project `TalentFlow_AI_Recruitment_PRO`.
3. Đảm bảo `.env` có `WORKFLOW_SHARED_SECRET`, `GROQ_API_KEY`, `SMTP_USER`, `SMTP_PASS`; `RECRUITMENT_NOTIFY_EMAIL` là tùy chọn (mặc định dùng `SMTP_USER`).
4. Chạy `docker compose up -d --build api web` sau khi cập nhật source. Không dùng `docker compose down -v` vì có thể xóa volume dữ liệu.
5. Mở n8n tại `http://localhost:5679`.

## 2. Import

Trong n8n chọn **Import from File** và import tất cả file `n8n/recruitment-*.workflow.json`. Có 12 file. Tất cả được để inactive khi import; mở từng workflow, kiểm tra node và chọn **Publish/Activate** theo phiên bản n8n.

Không bật một bản sao cũ có cùng webhook path. Nếu trước đó đã import workflow 01–05, hãy cập nhật workflow cũ hoặc ngừng bản cũ trước khi bật file mới để tránh path trùng.

## 3. Danh sách webhook

| Workflow | Webhook path | Backend endpoint |
|---|---|---|
| 01 CV Intake | `recruitment-cv-intake` | `POST /api/automation/verify-cv` |
| 02 AI Screening | `recruitment-ai-screening` | `POST /api/automation/screen-cv` |
| 03 Ranking | `recruitment-ranking` | `POST /api/automation/recalculate-ranking` |
| 04 Invitation | `recruitment-invite` | `POST /api/automation/send-invite` |
| 05 Follow-up | `recruitment-followup` | `POST /api/automation/send-reminders` |
| 06 Duplicate CV | `recruitment-duplicate-check` | `POST /api/automation/check-duplicate-cv` |
| 07 Normalize CV | `recruitment-cv-normalize` | `POST /api/automation/normalize-cv` |
| 08 Job match report | `recruitment-job-match` | `POST /api/automation/job-match` |
| 09 Schedule interview | `recruitment-schedule-interview` | `POST /api/automation/schedule-interview` |
| 10 Status notification | `recruitment-status-notify` | `POST /api/automation/notify-candidate-status` |
| 11 Daily report | `recruitment-daily-report` | `POST /api/automation/daily-report` |
| 12 Error monitoring | Error Trigger (không có webhook public) | `POST /api/automation/log-error` |

Các workflow webhook kiểm tra header `x-automation-token`. Backend HTTP Request dùng header `x-flow-token`. Hai giá trị phải khớp với `WORKFLOW_SHARED_SECRET` trong `.env`/n8n container.

## 4. Luồng tích hợp tự động

Khi upload CV qua ứng dụng, backend chặn email trùng cùng vị trí trước khi tạo hồ sơ. Nếu `AUTOMATION_PRO_ENABLED=true`, backend lần lượt gọi workflow 06 kiểm tra trùng (audit), 07 chuẩn hóa CV, 01 xác minh CV và 02 sàng lọc AI. Sau khi AI thành công, backend gọi 03 cập nhật ranking, 08 lấy báo cáo đối sánh và 10 gửi thông báo nội bộ. Khi đặt lịch, backend gọi workflow 09; nếu workflow chưa Publish, backend có đường dự phòng và vẫn thử gọi workflow 04 để gửi thư mời.

Workflow 05 chạy lịch nhắc hàng giờ. Backend chỉ gửi nhắc cho lịch còn hiệu lực, thư mời đã gửi và thời điểm phỏng vấn nằm trong cửa sổ 10 phút–24 giờ.

## 5. Payload mẫu để test

Thay các chuỗi `REPLACE_WITH_...` bằng UUID thật từ ứng dụng/database demo. Khi gọi webhook từ máy host, thêm header `x-automation-token` với giá trị `WORKFLOW_SHARED_SECRET` của chính nhóm; không gửi secret lên GitHub/chat.

### 06 – Duplicate CV check

```json
{
  "jobId": "REPLACE_WITH_JOB_UUID",
  "candidateId": "REPLACE_WITH_CANDIDATE_UUID",
  "email": "demo@example.com"
}
```

### 01 / 02 / 07 / 08 / 10 – Candidate workflow

```json
{ "candidateId": "REPLACE_WITH_CANDIDATE_UUID" }
```

### 03 – Ranking

```json
{ "jobId": "REPLACE_WITH_JOB_UUID" }
```

### 04 – Send invitation

```json
{ "interviewId": "REPLACE_WITH_INTERVIEW_UUID" }
```

### 09 – Schedule interview

```json
{
  "candidateId": "REPLACE_WITH_CANDIDATE_UUID",
  "startsAt": "2027-01-20T09:00:00+07:00",
  "durationMinutes": 30,
  "mode": "online",
  "meetingLink": "https://meet.example.com/demo",
  "notes": "Demo lịch phỏng vấn"
}
```

Candidate phải có `ai_status=ready`, thời gian phải ở tương lai, thời lượng 15–180 phút. Backend sẽ từ chối lịch trùng của cùng ứng viên.

### 05 – Follow-up

```json
{ "manual": true }
```

### 11 – Daily report

```json
{ "source": "manual" }
```

Workflow 12 không gọi bằng webhook. Mở workflow 12, Publish nó, rồi vào Settings của các workflow cần giám sát và chọn workflow này làm **Error Workflow**. Test bằng cách gây lỗi có kiểm soát trong workflow demo; không tạo lỗi bằng cách làm hỏng dữ liệu thật.

## 6. Kiểm thử và xử lý lỗi

- Mở từng workflow → tab **Executions** → kiểm tra node nào đỏ.
- HTTP 401: secret giữa webhook/backend không khớp.
- HTTP 404 webhook: workflow chưa Publish/Activate, path sai hoặc có bản cũ chiếm path.
- HTTP 401 ở backend: thiếu/sai `x-flow-token`.
- Groq 401/429: kiểm tra API key/quota/model; workflow không tạo điểm AI giả.
- Gmail lỗi: kiểm tra Gmail App Password, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT` và `RECRUITMENT_NOTIFY_EMAIL`.
- Nếu một workflow phụ trợ chưa hoạt động, xem `automation/runs` và `events` trong ứng dụng; không khẳng định workflow chạy thành công chỉ vì backend fallback hoàn tất.

## 7. Kiểm tra tĩnh

Trong thư mục project chạy:

```bash
python3 tests/verify_static.py
```

Bài kiểm tra này xác nhận có 12 JSON, mỗi file có ít nhất 7 node, webhook path không trùng, các endpoint/backend auth có khai báo. Đây là kiểm tra tĩnh; không thay thế việc chạy thử Docker, Groq, Gmail và n8n trên máy nhóm.
