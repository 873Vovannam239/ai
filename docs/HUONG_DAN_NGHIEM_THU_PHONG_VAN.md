# Nghiệm thu 3 workflow phỏng vấn — thành viên 3

Thành viên phụ trách **09 Đặt lịch**, **04 Gửi thư mời**, **05 Nhắc lịch**. Mục tiêu là ngăn lịch trùng, không gửi lại thư đã xác nhận thành công và xử lý được công việc bị gián đoạn. Dùng ứng viên, hộp thư và database demo do nhóm kiểm soát khi chạy nghiệm thu.

## 1. Quy tắc nghiệp vụ cần trình bày

### Workflow 09 — Đặt lịch phỏng vấn

- Ứng viên đã phân tích AI thành công; giờ bắt đầu ở tương lai; thời lượng 15–180 phút.
- Hai lịch có trạng thái `scheduled` của **cùng ứng viên** không được giao nhau, kể cả khi hai yêu cầu đến đồng thời. Khoảng thời gian là `[bắt đầu, kết thúc)`: lịch 09:00–09:30 và 09:30–10:00 được phép liền nhau.
- Lịch đã hủy không chiếm khung giờ. Dự án chưa có tài nguyên người phỏng vấn/phòng họp để chặn trùng giữa các ứng viên khác nhau.
- Tạo lịch và gửi email có kết quả riêng. Nếu đã lưu lịch nhưng thư mời đang xử lý hoặc lỗi, workflow trả `status: partial`, `scheduleSaved: true`, `ok: false`, HTTP 207 và giữ `result.id`. Khi đó xử lý thư mời của lịch này; không tạo một lịch khác để gửi lại.
- Lỗi nghiệp vụ từ backend giữ mã HTTP: 400 đầu vào sai, 404 không tìm thấy, 409 trùng lịch/xung đột. HTTP 200 chỉ xác nhận trọn quy trình khi backend xác nhận đã gửi thư.

### Workflow 04 — Gửi thư mời

- Chỉ gửi cho lịch còn hiệu lực, chưa qua thời điểm bắt đầu.
- Backend giữ quyền xử lý bằng một claim trong database. Hai lần gọi cùng lúc không cùng gửi một thư.
- Nếu `email_status = sent`, trả `sent: true, alreadySent: true`; không gọi SMTP lần nữa. Đây là hành vi khi bấm “Gửi lại” sau lần gửi thành công.
- Nếu một lượt gửi còn giữ claim, trả `sent: false, processing: true`. Workflow trả HTTP 202, `status: processing`, `ok: false`; chưa xác nhận đã gửi.
- Nếu kết quả giao thư không xác định (`unknown`), dừng gửi lại tự động; trả HTTP 409 và yêu cầu đối soát. Kiểm tra hộp thư đã gửi, nhật ký SMTP và `Message-ID` trước khi quyết định xử lý tiếp.

### Workflow 05 — Nhắc lịch

Cả chạy thủ công và chạy mỗi giờ đều dùng cùng điều kiện. Chỉ xét lịch thỏa **tất cả**:

1. `status = scheduled`, chưa bị hủy.
2. `email_status = sent`: thư mời đã được xác nhận gửi thành công.
3. Giờ phỏng vấn **lớn hơn 10 phút** và **không quá 24 giờ** tính từ thời điểm xét trong database.
4. Chưa có `reminder_sent_at`; trạng thái nhắc cho phép xử lý và claim thành công.

Backend kiểm tra lại điều kiện khi nhận claim và trước khi bắt đầu gửi. Việc bấm chạy thủ công không bỏ qua cửa sổ thời gian. Lịch đã qua giờ, còn đúng 10 phút, thư mời chưa gửi hoặc đã nhắc thành công sẽ không được gửi nhắc.

Kết quả chứa `due`, `sent`, `failed`, `processing`, `unknown`, `skipped`, `recovered`, `aiAssisted` và `status`. Đọc cả các bộ đếm; không kết luận thành công chỉ từ HTTP 200 của backend. Workflow không báo thành công khi có thư lỗi, đang xử lý hoặc chưa rõ kết quả. Một lượt được tính hoàn tất khi `due = sent + skipped`: `sent` chỉ tính thư do worker này gửi thật; `skipped` là công việc không còn cần gửi (worker khác đã gửi hoặc lịch không còn đủ điều kiện). Không cộng `skipped` vào số thư đã gửi. Nhánh lịch tự động sẽ ném lỗi khi chưa hoàn tất, để n8n đánh dấu Execution failed và gọi Error Workflow đã cấu hình.

## 2. Phục hồi khi gián đoạn

Claim có thời điểm nhận việc và thời điểm bắt đầu giao thư. Mỗi lần workflow 05 chạy, backend quét phục hồi cả thư mời lẫn thư nhắc; thư mời cũng được kiểm tra lại khi gọi gửi/gửi lại. Khi claim `sending` hết hạn:

| Điểm gián đoạn | Cách xử lý |
|---|---|
| Chưa bắt đầu gọi SMTP | Có thể thu hồi claim cũ và thử lại, sau khi kiểm tra điều kiện còn hợp lệ. `recovered` cho biết số việc đã phục hồi. |
| Đã bắt đầu gọi SMTP nhưng chưa lưu được kết quả | Đưa về `unknown`; không tự gửi lại vì thư có thể đã tới người nhận. |
| Đã lưu trạng thái `sent` | Các lần chạy sau bỏ qua, giữ nguyên dấu thời gian đã gửi. |
| SMTP trả lỗi rõ ràng là chưa chấp nhận thư | Ghi `failed` và chi tiết lỗi; có thể thử lại theo điều kiện nghiệp vụ. |

SMTP và cập nhật database là hai hệ thống riêng, nên không thể bảo đảm “giao thư đúng một lần” trong mọi trường hợp mất kết nối hoặc tiến trình dừng. `unknown` giúp tránh gửi trùng khi chưa có bằng chứng. Không sửa thẳng `unknown` thành `pending` rồi chạy lại mà chưa đối soát kết quả giao thư.

### Đối soát trạng thái `unknown`

Đối chiếu `email_message_id` hoặc `reminder_message_id`, giờ gửi, lỗi cuối cùng và Gmail Sent/nhật ký SMTP. Trước khi chuyển `unknown` về `failed`, dừng worker cũ hoặc chờ chắc chắn lượt gửi cũ đã kết thúc; claim hết hạn không chứng minh tiến trình đó đã dừng. Sau đó mới đối soát và cho phép thử lại để tránh một lượt SMTP cũ còn hoạt động. Thao tác dưới đây do người vận hành thực hiện sau khi có bằng chứng, trên đúng ID lịch:

- Xác nhận đã giao: đặt trạng thái tương ứng thành `sent` và dấu thời gian gửi thành `coalesce(dấu_thời_gian_hiện_có, now())`.
- Xác nhận chưa được SMTP chấp nhận: đặt trạng thái thành `failed`, xóa `*_delivery_started_at`, `*_attempt_id`, `*_attempt_started_at`, rồi cho quy trình xử lý lại nếu lịch còn hợp lệ.
- Chưa đủ bằng chứng: giữ `unknown`, trao đổi trực tiếp với người nhận hoặc nhà cung cấp SMTP; không bấm gửi lại liên tục.

Ví dụ cho thư mời đã được xác nhận gửi (thay UUID mẫu bằng ID thật của lịch demo):

```sql
UPDATE interviews
SET email_status = 'sent', email_sent_at = coalesce(email_sent_at, now()), email_error = NULL
WHERE id = 'REPLACE_WITH_INTERVIEW_UUID' AND email_status = 'unknown'
RETURNING id;
```

Ví dụ khi có bằng chứng thư nhắc chưa được SMTP chấp nhận:

```sql
UPDATE interviews
SET reminder_status = 'failed', reminder_delivery_started_at = NULL,
    reminder_attempt_id = NULL, reminder_attempt_started_at = NULL
WHERE id = 'REPLACE_WITH_INTERVIEW_UUID' AND reminder_status = 'unknown'
RETURNING id;
```

Không trả về bản ghi thì dừng và đọc lại trạng thái; không bỏ điều kiện `unknown` để ép cập nhật. Với thư nhắc đã gửi hoặc thư mời chưa gửi, áp dụng cùng quy tắc với nhóm cột `reminder_*` hoặc `email_*` tương ứng.

## 3. Cập nhật môi trường demo

1. Với database đã có volume, áp dụng migration trước khi chạy backend mới:

   ```bash
   docker compose exec -T db psql -U recruitment -d recruitment -v ON_ERROR_STOP=1 < sql/005_interview_reliability.sql
   ```

   Migration bổ sung trạng thái và dấu vết gửi thư; cơ chế khóa trong backend ngăn các yêu cầu đặt lịch mới bị giao nhau. Migration không tự phát hiện hay sửa các lịch trùng có sẵn; nhóm cần đối soát dữ liệu cũ riêng. Không xóa volume. Database tạo mới đã nhận cấu trúc cập nhật từ `001_schema.sql`.

2. Chạy `docker compose up -d --build api web`. Kiểm tra biến SMTP và shared secret bằng môi trường của nhóm; không đưa secret vào ảnh minh chứng.
3. Cập nhật ba workflow từ `n8n/recruitment-schedule-interview.workflow.json`, `n8n/recruitment-invite.workflow.json`, `n8n/recruitment-followup.workflow.json`. Giữ một bản hoạt động cho mỗi webhook path, tránh bật đồng thời bản cũ.
4. Trong HTTP Request, giữ **Include Response Headers and Status**, **Never Error**, định dạng JSON. Node đánh giá cần cả HTTP status và body để giữ mã 400/404/409.
5. Các file import để `inactive`. Sau khi kiểm tra cấu hình mới bật workflow. Import workflow 12, cấu hình workflow đó trong **Settings → Error Workflow** của workflow 05. Kiểm thử Error Workflow bằng execution chạy tự động; execution chạy thủ công trong editor có thể không kích hoạt Error Trigger.

## 4. Các ca nghiệm thu cần có

Chọn giờ test tương đối với thời điểm hiện tại, nhập múi giờ rõ ràng (`+07:00` hoặc `Z`). Chụp execution ID, trạng thái database và số thư trong hộp thư demo cho từng ca. Các ca biên đúng 10 phút/24 giờ nên dùng kiểm thử với đồng hồ cố định để không sai do thao tác chậm.

| Mã | Thao tác | Kết quả bắt buộc |
|---|---|---|
| 09-01 | Tạo lịch hợp lệ cho ứng viên đã AI ready | Một lịch được lưu; email có kết quả riêng, xác nhận thành công khi thực sự `sent`. |
| 09-02 | Tạo hai khoảng giao nhau cho cùng ứng viên | Yêu cầu thứ hai HTTP 409; không có lịch thứ hai. |
| 09-03 | Gửi đồng thời hai yêu cầu giao nhau | Chỉ một lịch `scheduled` được lưu; yêu cầu còn lại HTTP 409. |
| 09-04 | Tạo lịch bắt đầu đúng lúc lịch trước kết thúc | Được phép, không có phần thời gian giao nhau. |
| 09-05 | Làm lỗi gửi thư trong môi trường demo sau khi lưu lịch | Trả `partial`, `scheduleSaved: true`, giữ ID lịch; không báo đã gửi thành công. |
| 04-01 | Gửi thư thành công rồi gọi lại cùng `interviewId` | Lượt sau xác nhận `alreadySent`; hộp thư chỉ tăng một thư. |
| 04-02 | Hai lượt gọi cùng `interviewId` đồng thời | Chỉ một lượt giữ claim; lượt kia là `processing` hoặc `alreadySent` tùy thời điểm. |
| 04-03 | Gửi cho lịch hủy hoặc đã qua giờ | Bị từ chối, không gọi SMTP. |
| 04-04 | Claim hết hạn sau khi bắt đầu SMTP | Trạng thái `unknown`; gọi lại không gửi tiếp trước đối soát. |
| 05-01 | Lịch sau 2 giờ, thư mời `sent`, chưa nhắc | Gửi một thư nhắc, lưu `reminder_sent_at`; lượt sau không gửi lại. |
| 05-02 | Lịch còn đúng 10 phút, quá 24 giờ, đã qua giờ, đã hủy hoặc thư mời chưa `sent` | Từng trường hợp đều không gửi nhắc. |
| 05-03 | Lịch còn đúng 24 giờ với đồng hồ cố định | Được xét gửi nếu các điều kiện khác đúng. |
| 05-04 | Gián đoạn sau claim nhưng trước SMTP; claim hết hạn | Tự thu hồi và xử lý lại khi lịch còn đủ điều kiện; có số `recovered`. |
| 05-05 | Gián đoạn sau khi bắt đầu SMTP, chưa lưu kết quả | Chuyển `unknown`, không tự gửi thêm thư. |
| 05-06 | Một thư nhắc thành công và một thư lỗi | Có đủ `sent`/`failed`; kết quả `partial`, không báo thành công toàn bộ. |
| 05-07 | Cho lịch tự động gặp lỗi có kiểm soát trong môi trường demo | Execution failed; workflow 12 nhận lỗi khi đã được cấu hình, backend có audit tương ứng. |

Trạng thái `partial`/`processing` cần được đọc từ JSON dù mã HTTP thuộc nhóm 2xx. HTTP 207 chỉ nói rằng tác vụ đã hoàn thành một phần; không phải bằng chứng thư đã tới hộp thư.

## 5. Kiểm tra bằng mã

```bash
python3 tests/verify_static.py
node --test tests/interview-workflows.test.cjs
```

Bộ kiểm tra workflow chạy các node đánh giá bằng payload giả lập để xác nhận HTTP 409/202/207, `unknown`, kết quả gửi một phần, các bộ đếm và nhánh lỗi lịch tự động; không cần database hay kết nối n8n.

Kiểm tra tĩnh chỉ xác nhận cấu trúc file, node, đường dẫn và khai báo tích hợp. Để kiểm tra cạnh tranh và phục hồi với PostgreSQL thật, chuẩn bị một database cục bộ **riêng** có tên `talentflow_test` hoặc `talentflow_test_<hậu_tố>` rồi chạy:

```bash
TEST_DATABASE_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/talentflow_test' node --test tests/interview-reliability.test.cjs
```

Thay tài khoản thử nghiệm bằng giá trị cục bộ của nhóm. Bộ kiểm tra tạo schema riêng và dọn schema sau khi chạy; giả lập SMTP/Groq để không gửi thư hay gọi AI thật. Không có `TEST_DATABASE_URL` thì các bài PostgreSQL bị bỏ qua; kết quả bỏ qua không được tính là kiểm thử nghiệp vụ đã đạt. Chạy kiểm thử này không thay thế minh chứng tích hợp Gmail/n8n.

## 6. Minh chứng trình bày

Mỗi workflow trình bày theo thứ tự **input → điều kiện → claim/xử lý → output → nhánh lỗi**. Nộp bảng ca kiểm thử với kết quả thực tế, execution ID, ảnh database và hộp thư demo. Với ca gián đoạn, ghi rõ đã dừng ở trước hay sau bước bắt đầu SMTP để giải thích tại sao hệ thống được phép thử lại hoặc phải đối soát.
