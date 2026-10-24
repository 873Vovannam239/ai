# Đánh giá TalentFlow AI theo góc nhìn giáo viên no-code/low-code

Ngày đánh giá: 24/10/2026. Phạm vi: mã nguồn và tài liệu trong workspace; nhóm 4 thành viên, mỗi người 3 workflow.

## 1. Nhận xét chung

**Dự án đáp ứng số lượng 12 workflow; vấn đề cần nâng cấp là chiều sâu nghiệp vụ trên n8n, tính đúng của các trạng thái và bằng chứng kiểm thử.** Chủ đề tuyển dụng phù hợp để làm đồ án vì có chuỗi công việc rõ: nhận CV, đánh giá, xếp hạng, đặt lịch, gửi thư và theo dõi vận hành.

Đã xác nhận 12 JSON: 9 workflow có 11 node, 2 workflow có 19 node, 1 workflow có 9 node. Tất cả đáp ứng yêu cầu tối thiểu 7 node ghi trong tài liệu dự án. Đây là số node trên toàn đồ thị, gồm các nhánh; không có nghĩa mỗi lần chạy đi qua toàn bộ node.

Phần lớn workflow dùng cùng cấu trúc: Webhook → xác thực → chuẩn hóa input → kiểm tra → gọi một endpoint NestJS → đánh giá phản hồi → trả kết quả. Các node xác thực, kiểm tra và phản hồi có giá trị thật. Tuy nhiên, nếu chỉ trình diễn cấu trúc này, giảng viên khó đánh giá khả năng thiết kế nghiệp vụ bằng low-code của từng người.

Không cần viết lại toàn bộ hệ thống. Có thể giữ backend xử lý file, kiểm soát dữ liệu và giao dịch DB, đồng thời thể hiện điều kiện tiếp tục/dừng, nhánh nghiệp vụ, kết quả và xử lý lỗi rõ hơn trên canvas n8n.

## 2. Những điểm tốt nên giữ

- Phân công hiện tại đủ 4 người × 3 workflow và chia theo các nhóm nghiệp vụ hợp lý.
- Có API guard cho quản trị và automation; truy vấn SQL có tham số.
- Kết quả AI được kiểm tra định dạng; lỗi AI được lưu thay vì tạo điểm giả.
- Xếp hạng theo vị trí có transaction và khóa; thư mời có bước nhận quyền gửi để hạn chế gửi trùng.
- Có hướng dẫn import, payload mẫu, kịch bản demo và lịch sử automation.
- Tài liệu xác định AI hỗ trợ chuyên viên, quyết định tuyển dụng do con người thực hiện.

## 3. Khuyết điểm và hướng khắc phục

### A. Cần sửa trước khi bảo vệ

**1. Nghiệp vụ low-code chưa thể hiện rõ.**

Ví dụ workflow AI có một HTTP Request gọi `/api/automation/screen-cv` tại `n8n/recruitment-ai-screening.workflow.json:103`; chuẩn hóa CV và xếp hạng thực hiện trong `backend/src/service.ts:223` và `:307`. Đây là kiến trúc tích hợp hợp lệ, nhưng số lượng workflow chưa chứng minh 12 bài toán tự động hóa có chiều sâu tương đương nhau.

Khắc phục: với mỗi workflow, chỉ rõ trigger, input, điều kiện nghiệp vụ, hành động, output và nhánh lỗi. Dùng các bước cấu hình trên n8n cho điều phối, biến đổi dữ liệu đơn giản và phân nhánh phù hợp. Không thêm node chỉ để tăng số lượng; giải thích được vì sao bước đó cần tồn tại.

**2. Kiểm tra CV chưa kiểm soát việc tiếp tục quy trình.**

`backend/src/service.ts:34` kiểm tra trùng bằng code rồi lưu hồ sơ ở dòng 36. Sau đó mới gọi workflow 06, 07, 01 ở dòng 41–43; kết quả ba lần gọi này không quyết định có chạy workflow AI tiếp hay không. Workflow 06 hiện có vai trò kiểm tra/audit sau lưu, còn việc chặn upload trùng chủ yếu do backend.

Khắc phục: xác định rõ chuỗi hợp lệ → không trùng → chuẩn hóa/xác minh thành công → phân tích AI. Nếu cần lưu trước để cấp ID, lưu dưới trạng thái tiếp nhận tạm và chỉ chuyển sang hợp lệ khi qua kiểm tra. Lỗi xác thực nội dung phải dừng; lỗi dịch vụ phải có trạng thái chờ/thử lại hoặc bước dự phòng được ghi nhận rõ.

**3. Thành công HTTP đang bị đồng nhất với thành công nghiệp vụ.**

- `jobMatchReport()` có thể trả `ready:false` tại `backend/src/service.ts:240`, nhưng workflow 08 đặt `businessOk=true` tại `n8n/recruitment-job-match.workflow.json:133`.
- Báo cáo vẫn trả `ok:true` khi `emailSent:false` tại `backend/src/service.ts:267`; workflow 11 chủ yếu kiểm tra lỗi HTTP.
- Nhắc lịch vẫn ghi automation `success` khi có thư thất bại tại `backend/src/service.ts:360`.

Khắc phục: thống nhất các trạng thái `pending`, `success`, `partial`, `failed`; thêm IF theo kết quả nghiệp vụ của từng workflow. Ví dụ: báo cáo được tạo nhưng gửi thư lỗi là `partial`; job match chưa có AI là `pending`; gửi nhắc 5 thư thành công và 1 thư lỗi là `partial`, kèm số lượng và hướng thử lại. Việc đổi trạng thái cần cập nhật đồng bộ API, bảng log và giao diện.

**4. Workflow 12 chưa đủ để bảo đảm giám sát lỗi.**

JSON hiện chỉ có `executionOrder` trong settings, chưa gắn `errorWorkflow`, ví dụ `n8n/recruitment-ai-screening.workflow.json:346`. Tài liệu đã yêu cầu chọn Error Workflow sau import; chưa có bằng chứng runtime cho thấy việc đó đã được thực hiện. Nhiều HTTP node dùng `continueOnFail`; nhánh lỗi của lịch nhắc chỉ trả dữ liệu `ok:false` tại `n8n/recruitment-followup.workflow.json:352`.

Khắc phục: cấu hình workflow 12 sau import. Lỗi nghiệp vụ đã được bắt phải được ghi nhận/cảnh báo rõ hoặc chuyển thành lỗi execution theo chủ đích. Tạo một lỗi có kiểm soát và chứng minh có execution, audit và cảnh báo tương ứng. Phân biệt phản hồi lỗi cho người gọi với trạng thái execution trong n8n.

**5. Chưa đủ bằng chứng nghiệm thu chức năng.**

`tests/verify_static.py:1` xác định rõ đây là kiểm tra tĩnh. Nó xác nhận file/node/path/endpoint và một số chuỗi cấu hình, chưa kiểm tra chống trùng khi gửi đồng thời, lịch nhắc, kết quả email hoặc toàn bộ pipeline. Tài liệu hiện có nhiều checklist chưa đánh dấu; điều này không chứng minh hệ thống chưa chạy, nhưng chưa đủ để người chấm đối chiếu.

Khắc phục: mỗi workflow có ít nhất một ca thành công và một ca ngoại lệ, lưu input, kết quả mong đợi, kết quả quan sát, execution ID và thay đổi DB/email. Ghi rõ xử lý qua n8n hay backend dự phòng. Nếu backend hoàn tất khi n8n chưa chạy, không dùng kết quả đó làm bằng chứng workflow đã thực thi.

### B. Cần sửa để tăng độ tin cậy và chiều sâu đồ án

**6. Chống trùng chưa an toàn với hai yêu cầu đồng thời.**

Backend dùng SELECT rồi INSERT cho email tại `backend/src/service.ts:34` và lịch tại `:107`; schema chưa có ràng buộc tương ứng. Hai yêu cầu cùng lúc có thể đều vượt bước kiểm tra.

Khắc phục: thêm ràng buộc duy nhất theo vị trí và email đã chuẩn hóa; lịch dùng khóa/giao dịch hoặc ràng buộc chống chồng thời gian. Cần xử lý dữ liệu trùng đang có trước khi thêm ràng buộc. Nghiệm thu bằng hai yêu cầu đồng thời, không chỉ bấm lần lượt.

**7. Nhắc lịch có thể kẹt ở `sending`.**

`backend/src/service.ts:342` chuyển trạng thái nhắc sang `sending`; lần chạy sau chỉ chọn `pending/failed` tại dòng 337. Nếu tiến trình dừng giữa chừng, bản ghi có thể không được chọn lại.

Khắc phục: bổ sung thời điểm bắt đầu gửi, nhận diện bản ghi xử lý quá hạn và cơ chế phục hồi. Theo dõi số lần thử và trường hợp chưa xác định email đã gửi hay chưa để hạn chế gửi trùng. Có thể học từ cơ chế thư mời tại `service.ts:153`.

**8. Điểm AI có rubric nhưng thiếu bằng chứng kiểm chứng.**

`backend/src/groq.ts:113` đã nêu trọng số 45/30/15/10 và yêu cầu tránh dùng thông tin cá nhân; không nên nhận xét là hoàn toàn chưa có tiêu chí. Tuy nhiên, output hiện chỉ chứa tổng điểm và các mảng nhận xét, chưa có điểm thành phần, dẫn chứng CV cho từng tiêu chí hoặc phiên bản đánh giá được lưu cùng kết quả.

Khắc phục: thêm bảng tiêu chí, điểm từng mục và dẫn chứng liên quan; đánh dấu trường thiếu dữ liệu. Lưu model/prompt version và thời điểm phân tích. Chuẩn bị khoảng 10 CV giả được nhóm chấm tay để so sánh, trong đó có CV thiếu dữ liệu và CV chứa chỉ dẫn gây nhiễu. Không coi nhãn confidence do model tự trả là độ chính xác đã được đo.

**9. Xếp hạng có thể cũ sau khi phân tích lại.**

`backend/src/service.ts:59` xóa điểm AI khi phân tích lại nhưng không xóa rank; ranking chỉ được gọi sau AI thành công tại dòng 65. Nếu AI lỗi hoặc workflow ranking lỗi, giao diện có thể tiếp tục hiển thị rank của lần đánh giá trước qua truy vấn tại dòng 26.

Khắc phục: đánh dấu/xóa rank hết hiệu lực khi bắt đầu phân tích lại; chỉ hiển thị thứ hạng gắn với kết quả AI hiện hành. Nêu rõ cách xử lý bằng điểm và chỉ so sánh trong cùng JD.

**10. Một số workflow cần đầu ra khác biệt rõ hơn.**

Workflow 08 hiện đọc lại kết quả AI đã lưu tại `backend/src/service.ts:234`; chưa tạo bảng đối chiếu từng yêu cầu với dẫn chứng. Workflow 11 đang tổng hợp số liệu toàn bộ dữ liệu tại dòng 260, chưa lọc theo ngày. Workflow 10 được gọi trong nhánh AI thành công tại dòng 67, chưa được gọi tự động trong nhánh AI lỗi.

Khắc phục: WF08 tạo báo cáo yêu cầu → dẫn chứng → mức đáp ứng → điều cần xác minh, có bản lưu/xuất được. WF11 tách tổng tích lũy và phát sinh trong kỳ, ghi khoảng thời gian báo cáo. WF10 bổ sung thông báo lỗi AI và chống gửi lại cùng một sự kiện.

**11. Trải nghiệm đặt lịch và trạng thái hệ thống còn lệch với dữ liệu.**

- `frontend/app/page.tsx:55` hiển thị “Groq Connected” dựa vào có key; `backend/src/service.ts:13` chưa kiểm tra một lần gọi Groq thành công.
- Tiêu đề tại `frontend/app/page.tsx:62` nói cả 12 workflow hoạt động, trong khi phần bên dưới là log backend.
- UI đọc câu hỏi phỏng vấn trong `automation.aiInterviewGuide` tại dòng 48, nhưng đường backend dự phòng trả trường đó ở cấp ngoài tại `service.ts:124`.
- Kiểm tra lịch hiện xét cùng ứng viên; chưa có thông tin người phỏng vấn/phòng để kiểm tra xung đột tài nguyên.

Khắc phục: nhãn “đã cấu hình” phản ánh cấu hình; trạng thái thực thi lấy từ lần chạy có chứng cứ. Thống nhất cấu trúc phản hồi đặt lịch. Bổ sung người phỏng vấn/phòng nếu phạm vi đề bài yêu cầu; nếu chưa làm thì mô tả đúng giới hạn hiện có.

## 4. Phân công 4 người, mỗi người đúng 3 workflow

Giữ phân nhóm hiện tại. Mỗi người chịu trách nhiệm thiết kế, cấu hình, xử lý lỗi, kiểm thử và trình bày ba workflow của mình; backend/giao diện hỗ trợ được ghi thành nhiệm vụ phụ riêng.

| Thành viên | Workflow | Việc cần hoàn thiện | Điều kiện nghiệm thu chính |
|---|---|---|---|
| 1 — Dữ liệu đầu vào | 01 — CV Intake | Làm rõ tiếp nhận sự kiện hồ sơ và điều kiện đủ để xử lý tiếp | Hồ sơ thiếu nội dung bị dừng; hồ sơ hợp lệ có trạng thái và log |
| 1 — Dữ liệu đầu vào | 06 — Duplicate Check | Quyết định nhánh trùng/không trùng; thống nhất với chặn trùng trong DB | Cùng email/cùng JD bị chặn; cùng email/khác JD được xử lý; thử đồng thời |
| 1 — Dữ liệu đầu vào | 07 — Normalize CV | Thể hiện quy tắc chuẩn hóa, số ký tự và kết quả trước/sau | Giữ nguyên thông tin chuyên môn; chạy lại không làm nội dung tiếp tục biến đổi |
| 2 — AI và đánh giá | 02 — AI Screening | Điểm thành phần, dẫn chứng, dữ liệu thiếu và xử lý AI lỗi | JSON hợp lệ được lưu; JSON sai/timeout trả lỗi rõ; có kết quả so với chấm tay |
| 2 — AI và đánh giá | 03 — Ranking | Quy tắc xếp hạng cùng JD, bằng điểm và rank hết hiệu lực | Chỉ ứng viên đủ điều kiện có rank; phân tích lại không hiển thị rank cũ |
| 2 — AI và đánh giá | 08 — Job Match Report | Tạo báo cáo đối chiếu từng yêu cầu thay vì chỉ lấy tổng điểm | Có dẫn chứng, phần chưa đáp ứng; chưa có AI trả trạng thái chờ |
| 3 — Phỏng vấn | 09 — Schedule Interview | Kiểm tra lịch, thông tin buổi phỏng vấn và phản hồi thống nhất | Lịch quá khứ/trùng bị từ chối; lưu lịch trước khi phát yêu cầu thư mời |
| 3 — Phỏng vấn | 04 — Interview Invitation | Kiểm tra trạng thái gửi, chống gửi trùng, cho phép thử lại lỗi | Gọi lặp không gửi hai thư mời khi đã thành công; SMTP lỗi được phản ánh |
| 3 — Phỏng vấn | 05 — Follow-up | Điều kiện đến hạn, tổng hợp gửi/lỗi và phục hồi `sending` | Không nhắc lịch hủy/quá hạn/chưa gửi mời; có thử phục hồi sau gián đoạn |
| 4 — Vận hành | 10 — Recruiter Notification | Thông báo AI thành công/lỗi và tránh gửi lại cùng sự kiện | Đúng người nhận; trạng thái lỗi có thông báo; có kết quả gửi |
| 4 — Vận hành | 11 — Daily Report | Thống kê theo kỳ, tổng tích lũy và nhánh email lỗi | Số liệu khớp dữ liệu mẫu; email lỗi trả `partial/failed`; có thể gửi lại |
| 4 — Vận hành | 12 — Error Monitoring | Liên kết workflow, phân loại lỗi, ghi log và kiểm tra cảnh báo | Lỗi kiểm soát có workflow ID/execution ID, audit và kết quả cảnh báo |

Thành viên 2 có khối lượng AI khó hơn; thành viên 4 có thể hỗ trợ chuẩn bị dữ liệu kiểm thử và tích hợp nhưng vẫn sở hữu đúng ba workflow. Điền họ tên thật, commit/PR và bằng chứng vào bảng phân công; không suy ra thiếu đóng góp cá nhân chỉ từ tài liệu đang ghi “Bạn 1…4”.

## 5. Các quy ước nhóm cần thống nhất

- Mỗi sự kiện có mã đối chiếu xuyên suốt, ví dụ `correlationId`, cùng `candidateId/jobId/interviewId` phù hợp.
- Kết quả phân biệt trạng thái chờ, thành công, thành công một phần và thất bại; có mã lỗi và bước cần xử lý tiếp.
- Ghi nguồn xử lý `n8n` hoặc `backend fallback`, phiên bản đánh giá AI và mã execution khi có.
- Trước khi đặt lịch cần thao tác xác nhận của người tuyển dụng; điểm AI là đầu vào hỗ trợ.
- Thống nhất thời gian chờ giữa các tầng. Hiện Groq có ngân sách đến 75 giây tại `backend/src/groq.ts:22`, còn HTTP của WF02 và backend gọi WF02 chỉ chờ 60 giây; hậu xử lý còn gọi các workflow phụ. Có thể dùng xử lý bất đồng bộ với trạng thái công việc, hoặc thiết kế lại ngân sách chờ đồng bộ. Không chỉ tăng một timeout đơn lẻ.

## 6. Kế hoạch sửa và bằng chứng bảo vệ

**Đợt 1 — Bảo đảm quy trình đúng:** sửa thứ tự/điều kiện CV, kết quả nghiệp vụ, ghi nhận lỗi và trạng thái gửi; liên kết WF12. Ghi rõ nguồn xử lý để kiểm tra được n8n đã thực thi bước nào.

**Đợt 2 — Làm rõ giá trị 12 workflow:** tăng chiều sâu WF08/WF11, điểm AI có dẫn chứng, xử lý rank cũ và các trường hợp chạy lặp/đồng thời. Mỗi canvas phải thể hiện được quyết định riêng của nghiệp vụ.

**Đợt 3 — Chuẩn bị bảo vệ:** mỗi người có 3 phiếu workflow và tối thiểu 6 ca thử cho phần mình. Chuẩn bị một hành trình xuyên suốt để demo trực tiếp, kèm bảng chứng cứ cho đủ 12 workflow. Dữ liệu demo là CV/JD giả và hộp thư nhóm sở hữu.

Mẫu phiếu cho mỗi workflow:

| Nội dung | Nhóm cần ghi |
|---|---|
| Chủ sở hữu | Họ tên, workflow ID/tên, commit hoặc PR |
| Bài toán | Ai cần tự động hóa việc gì, khi nào bắt đầu |
| Input | Payload mẫu, điều kiện hợp lệ, dữ liệu phụ thuộc |
| Logic | Nhánh tiếp tục/dừng, quy tắc nghiệp vụ, lý do dùng từng node |
| Output | Response, thay đổi trạng thái/DB, email hoặc báo cáo |
| Ca thành công | Input, expected output, actual output, execution ID |
| Ca ngoại lệ | Lỗi đầu vào/dịch vụ/chạy lặp, expected output, actual output |

Các ca tích hợp cần có: CV hợp lệ đi hết quy trình; CV trùng; AI lỗi/JSON sai; phân tích lại rồi ranking lỗi; đặt lịch trùng; gửi thư lỗi rồi thử lại; nhắc lịch đúng/sai cửa sổ; báo cáo tạo được nhưng email lỗi; lỗi workflow được WF12 ghi nhận.

## 7. Phạm vi đã xác minh

- `python3 tests/verify_static.py`: **PASS**.
- Frontend TypeScript với `--noEmit --incremental false`: **PASS**.
- Đã đọc source backend, frontend, SQL, 12 workflow và tài liệu phân công/demo.
- Chưa import/chạy thử 12 workflow trên n8n và chưa kiểm chứng Groq, SMTP hoặc Schedule thực tế trong lượt đánh giá này. Các ca nghiệm thu nêu trên là công việc đề xuất, chưa được coi là đã hoàn thành.

Đánh giá này dùng để định hướng sửa đồ án. Chưa có rubric chính thức hoặc bằng chứng runtime đầy đủ để gán điểm số đáng tin cậy.
