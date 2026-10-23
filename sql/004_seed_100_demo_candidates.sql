-- 100 hồ sơ ứng viên giả lập. Email dùng example.com, không thuộc người thật.
-- Hồ sơ ở trạng thái pending để ứng dụng không hiển thị kết quả AI giả.
-- Nếu database chưa có tin tuyển dụng, tạo một vị trí demo trước.
INSERT INTO jobs(title, department, location, description, requirements)
SELECT 'Vị trí demo tổng hợp', 'Demo', 'TP. Hồ Chí Minh',
       'Vị trí mẫu để liên kết hồ sơ ứng viên demo trong TalentFlow.',
       'Dữ liệu giả lập phục vụ trình diễn ứng dụng.'
WHERE NOT EXISTS (SELECT 1 FROM jobs);

WITH
first_names AS (
  SELECT ARRAY['An','Bình','Chi','Dũng','Giang','Hà','Hải','Hạnh','Hiếu','Hoàng','Khánh','Linh','Long','Mai','Minh','Nam','Ngọc','Phúc','Quân','Thảo']::text[] AS v
),
last_names AS (
  SELECT ARRAY['Nguyễn','Trần','Lê','Phạm','Hoàng','Huỳnh','Phan','Vũ','Võ','Đặng','Bùi','Đỗ','Hồ','Ngô','Dương','Lý','Đào','Trương','Mai','Tạ']::text[] AS v
),
numbered_jobs AS (
  SELECT id, title, department,
         row_number() OVER (ORDER BY created_at, id) AS rn,
         count(*) OVER () AS total
  FROM jobs WHERE status='open'
),
demo AS (
  SELECT n,
         (ln.v[((n-1) / 20) + 1] || ' ' || fn.v[((n-1) % 20) + 1]) AS candidate_name,
         'demo.candidate' || lpad(n::text, 3, '0') || '@example.com' AS candidate_email,
         j.id AS job_id,
         j.title AS job_title,
         j.department AS department
  FROM generate_series(1,100) AS g(n)
  CROSS JOIN first_names fn
  CROSS JOIN last_names ln
  JOIN numbered_jobs j ON j.rn = ((n - 1) % j.total) + 1
)
INSERT INTO candidates(job_id, name, email, cv_filename, cv_text, ai_status)
SELECT d.job_id,
       d.candidate_name,
       d.candidate_email,
       'demo-cv-' || lpad(d.n::text, 3, '0') || '.txt',
       format('Hồ sơ giả lập số %s. Ứng viên %s ứng tuyển vị trí %s thuộc phòng ban %s. Có kinh nghiệm làm việc theo nhóm, lập kế hoạch, giao tiếp với các bên liên quan và giải quyết vấn đề. Đã tham gia các dự án thực hành, biết ghi nhận yêu cầu, theo dõi tiến độ và báo cáo kết quả. Kỹ năng chuyên môn sẽ được bổ sung theo vị trí; đây là dữ liệu mẫu để thử giao diện và quy trình phân tích CV.',
              d.n, d.candidate_name, d.job_title, d.department),
       'pending'
FROM demo d
WHERE NOT EXISTS (
  SELECT 1 FROM candidates c WHERE lower(c.email)=lower(d.candidate_email)
);
