# Phân công TalentFlow AI Recruitment PRO cho nhóm 4 người

Yêu cầu: **4 thành viên × 3 workflow/người = 12 workflow**; mỗi workflow có **ít nhất 7 node/step**. Các workflow trong thư mục `n8n/` hiện được thiết kế từ 9 đến 19 node và đều để `active: false` nhằm tránh chạy tự động trước khi nhóm cấu hình.

## Phân công đề xuất

| Thành viên | Workflow | Phần việc cần chịu trách nhiệm |
|---|---|---|
| Bạn 1 – CV Intake | 01 · CV Intake – verify candidate | **11 node** · Webhook, xác thực secret, kiểm tra candidateId, gọi NestJS xác minh CV, trả kết quả |
| Bạn 1 – CV Intake | 06 · Duplicate CV check | **11 node** · Chuẩn hóa email, kiểm tra hồ sơ trùng theo vị trí, trả kết quả và log |
| Bạn 1 – CV Intake | 07 · CV text normalization | **11 node** · Chuẩn hóa xuống dòng/khoảng trắng CV, ghi audit event |
| Bạn 2 – AI | 02 · AI Screening – Groq live | **11 node** · Gọi backend để Groq phân tích CV và lưu điểm/tóm tắt/kỹ năng/khoảng trống |
| Bạn 2 – AI | 03 · Candidate Ranking by job | **11 node** · Xếp hạng ứng viên theo vị trí tuyển dụng, lưu bảng xếp hạng |
| Bạn 2 – AI | 08 · CV and job requirement match report | **11 node** · Đọc kết quả AI đã lưu và tạo báo cáo đối sánh CV/JD |
| Bạn 3 – Interview | 04 · Interview Invitation – Gmail | **11 node** · Gửi thư mời Gmail, chống gửi trùng, kiểm tra kết quả SMTP |
| Bạn 3 – Interview | 05 · Follow-up – scheduled interview reminders | **19 node** · Trigger thủ công và Schedule hàng giờ; nhắc lịch đủ điều kiện |
| Bạn 3 – Interview | 09 · Schedule interview and send invitation | **11 node** · Kiểm tra payload/lịch trùng, tạo lịch và kích hoạt workflow gửi thư mời |
| Bạn 4 – Ops/QA | 10 · Notify recruiter of AI status | **11 node** · Gửi email nội bộ sau khi có kết quả phân tích AI |
| Bạn 4 – Ops/QA | 11 · Daily recruitment report | **19 node** · Tạo báo cáo định kỳ, Schedule mỗi ngày lúc 08:00 và hỗ trợ gọi thủ công |
| Bạn 4 – Ops/QA | 12 · Error monitoring and audit | **9 node** · Nhận lỗi từ Error Trigger, ghi audit log, gửi cảnh báo email khi lỗi nghiêm trọng |

## Nguyên tắc làm việc nhóm

1. Mỗi thành viên sở hữu phần code/workflow được giao và tự kiểm thử trước khi merge.
2. Tạo commit theo thay đổi có ý nghĩa, ví dụ `feat: add duplicate CV workflow`, không tạo commit giả để tăng số lượng.
3. Mọi workflow đều cần demo được input, node xử lý, kết quả backend và execution log.
4. Không dùng CV thật nếu chưa có căn cứ xử lý phù hợp; dùng dữ liệu giả khi demo trước lớp.
5. AI chỉ hỗ trợ đánh giá, không tự động ra quyết định tuyển/loại ứng viên.

## Checklist trước khi báo cáo

- [ ] Đã import đủ 12 file JSON.
- [ ] Mỗi workflow có ít nhất 7 node.
- [ ] Đã kiểm tra `WORKFLOW_SHARED_SECRET` giống nhau trong `.env` và n8n container.
- [ ] Đã Publish các workflow cần chạy.
- [ ] Đã chọn workflow 12 làm Error Workflow trong Settings của các workflow cần giám sát.
- [ ] Đã thử luồng CV → Groq → ranking/match/status notification.
- [ ] Đã thử đặt lịch và kiểm tra trạng thái thư mời.
- [ ] Đã thử báo cáo và kiểm tra audit log.
- [ ] Đã lưu ảnh Executions thành công làm minh chứng.
