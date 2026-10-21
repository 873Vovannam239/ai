# Kịch bản demo TalentFlow AI Recruitment PRO (10–12 phút)

## Demo chính

1. (1 phút) Giới thiệu kiến trúc Next.js → NestJS → PostgreSQL, n8n điều phối, Groq phân tích AI và Gmail SMTP gửi thư.
2. (1 phút) Tạo tin tuyển dụng mẫu; tải CV giả PDF có text hoặc DOCX. Nhắc rõ backend chặn email trùng cùng vị trí.
3. (1 phút) Mở workflow 06 và 07: kiểm tra trùng CV và chuẩn hóa văn bản. Chỉ ra dữ liệu truyền qua webhook là ID/trường cần thiết, không đưa API key/Gmail password vào payload.
4. (1 phút) Mở workflow 01: Webhook → xác thực shared secret → validate ID → NestJS xác minh CV → trả kết quả.
5. (1 phút) Mở workflow 02: NestJS gọi Groq thật, lưu score/summary/skills/gaps; nếu quota hết thì báo lỗi thật, không sinh điểm giả.
6. (1 phút) Mở workflow 03 và 08: cập nhật ranking theo JD và xem báo cáo đối sánh từ kết quả AI đã lưu.
7. (1–2 phút) Chọn ứng viên đã phân tích, đặt lịch trong tương lai. Backend thử gọi workflow 09; workflow này tạo lịch và kích hoạt workflow 04. Kiểm tra trạng thái thư mời, Gmail Sent và n8n Executions. Dùng email demo do nhóm sở hữu.
8. (1 phút) Mở workflow 05, chỉ ra Schedule hàng giờ và quy tắc chỉ nhắc lịch có thư mời đã gửi, chưa hết hạn, nằm trong cửa sổ 10 phút–24 giờ.
9. (1 phút) Mở workflow 10 để giải thích thông báo trạng thái AI cho người tuyển dụng; mở workflow 11 để tạo báo cáo tuyển dụng và kiểm tra email nhận báo cáo.
10. (1 phút) Giới thiệu workflow 12: Error Trigger ghi lỗi vào audit log và gửi email cảnh báo khi phân loại lỗi critical. Chỉ ra lịch sử automation/events trong hệ thống.
11. (1 phút) Tổng kết: 12 workflow, 3 workflow/người × 4 thành viên, mỗi workflow có ít nhất 7 node; tách biệt điều phối n8n với nghiệp vụ/DB/AI trong NestJS.

## Chia demo theo thành viên

- **Bạn 1:** Workflow 01, 06, 07 – CV intake, kiểm tra trùng, chuẩn hóa CV.
- **Bạn 2:** Workflow 02, 03, 08 – AI screening, ranking, job match.
- **Bạn 3:** Workflow 04, 05, 09 – thư mời, nhắc lịch, đặt lịch.
- **Bạn 4:** Workflow 10, 11, 12 – thông báo trạng thái, báo cáo, giám sát lỗi.

## Câu hỏi thường gặp

- **AI thật ở đâu?** `backend/src/groq.ts` gửi HTTPS request đến GroqCloud và trả JSON; `backend/src/service.ts` lưu kết quả. Workflow 02 điều phối, còn workflow 08 đọc báo cáo từ kết quả đã lưu.
- **Tại sao một số node gọi HTTP Request?** n8n điều phối; NestJS thực hiện validation/nghiệp vụ và thao tác PostgreSQL. Mỗi HTTP Request gọi endpoint thật trong backend.
- **Có phải cứ workflow có 7 node là đủ?** Không. 7 node là điều kiện tối thiểu của đề bài; nhóm phải trình bày input, logic, nhánh thành công/thất bại, output và execution thực tế.
- **Nếu workflow chưa Publish?** Backend có fallback cho một số thao tác, nhưng không được nói n8n đã chạy thành công. Kiểm tra `Executions`, `events` và `automation_runs`.
- **AI tự quyết định nhận/loại ứng viên không?** Không. AI là công cụ hỗ trợ; người tuyển dụng chịu trách nhiệm quyết định.
- **Dữ liệu cá nhân?** Chỉ dùng CV demo hoặc dữ liệu được phép xử lý. Tránh chia sẻ key, mật khẩu, email cá nhân hay CV thật khi trình chiếu.

## Kiểm tra trước demo

- [ ] Import đủ 12 workflow, không có path trùng với bản cũ.
- [ ] Publish các workflow cần trình diễn; cấu hình workflow 12 làm Error Workflow.
- [ ] `http://localhost:3001` mở được; `http://localhost:5679` mở n8n.
- [ ] `/api/health` báo DB kết nối và `aiConfigured: true` nếu demo AI.
- [ ] Thử upload CV giả, kiểm tra AI score và ranking.
- [ ] Thử lịch phỏng vấn/email; kiểm tra Inbox, Spam và Sent.
- [ ] Thử báo cáo và kiểm tra log.
- [ ] Có ảnh chụp Executions thành công để minh chứng.
