import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { DbService } from './db';
import { GroqService } from './groq';
import { MailService } from './mail';
import * as crypto from 'node:crypto';
const clean = (v:unknown,max=1000) => String(v ?? '').trim().slice(0,max);
const uuid = (v:string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly processing = new Set<string>();
  constructor(private readonly db:DbService,private readonly groq:GroqService,private readonly mail:MailService) {}
  async health() { await this.db.rows('SELECT 1');return {ok:true,db:'connected',aiConfigured:!!process.env.GROQ_API_KEY?.trim(),smtpConfigured:!!process.env.SMTP_USER?.trim()&&!!process.env.SMTP_PASS?.trim(),n8nConfigured:!!process.env.N8N_WEBHOOK_URL?.trim(),proEnabled:process.env.AUTOMATION_PRO_ENABLED==='true'}; }
  async dashboard() {
    const [stats]=await this.db.rows(`SELECT (SELECT count(*) FROM jobs WHERE status='open')::int AS open_jobs,(SELECT count(*) FROM candidates)::int AS candidates,(SELECT count(*) FROM candidates WHERE ai_status='ready')::int AS analyzed,(SELECT count(*) FROM interviews WHERE status='scheduled')::int AS interviews,(SELECT count(*) FROM interviews WHERE email_status='sent')::int AS emails_sent`);
    return stats;
  }
  async jobs() {return this.db.rows('SELECT * FROM jobs ORDER BY created_at DESC');}
  async createJob(v:any) {
    const title=clean(v?.title,180),description=clean(v?.description,10000),requirements=clean(v?.requirements,10000);
    if(title.length<3||description.length<10||requirements.length<5)throw new BadRequestException('Điền tên vị trí, mô tả (>=10 ký tự) và yêu cầu (>=5 ký tự).');
    const job=await this.db.one('INSERT INTO jobs(title,department,location,description,requirements) VALUES($1,$2,$3,$4,$5) RETURNING *',[title,clean(v.department,120)||'Chung',clean(v.location,120)||'Việt Nam',description,requirements]);
    await this.db.event('job',`Đã tạo tin tuyển dụng: ${title}`,job!.id);
    return job;
  }
  async candidates(jobId?:string) {if(jobId&&!uuid(jobId))throw new BadRequestException('jobId không hợp lệ');return this.db.rows(`SELECT c.id,c.job_id,c.name,c.email,c.cv_filename,c.ai_status,c.score,c.ai_summary,c.ai_strengths,c.ai_gaps,c.ai_skills,c.ai_confidence,c.ai_error,c.analyzed_at,c.created_at,c.cv_verified_at,r.rank_position,c.job_id,j.title AS job_title FROM candidates c JOIN jobs j ON j.id=c.job_id LEFT JOIN candidate_rankings r ON r.candidate_id=c.id WHERE ($1::uuid IS NULL OR c.job_id=$1::uuid) ORDER BY c.score DESC NULLS LAST,c.created_at DESC`,[jobId||null]);}
  async upload(jobId:string,name:string,email:string,filename:string,contents:string) {
    if(!uuid(jobId))throw new BadRequestException('Chọn vị trí cần ứng tuyển.');
    const job=await this.db.one('SELECT * FROM jobs WHERE id=$1',[jobId]);
    if(!job||job.status!=='open')throw new BadRequestException('Tin tuyển dụng không tồn tại hoặc đã đóng.');
    name=clean(name,160);email=clean(email,260).toLowerCase();
    if(name.length<2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new BadRequestException('Họ tên hoặc email ứng viên không hợp lệ.');
    if(contents.trim().length<100)throw new BadRequestException('CV thiếu nội dung hoặc PDF chỉ chứa hình ảnh (cần CV PDF có thể copy chữ hoặc DOCX).');
    const duplicate=await this.db.one('SELECT id FROM candidates WHERE job_id=$1 AND lower(email)=lower($2) LIMIT 1',[jobId,email]);
    if(duplicate)throw new ConflictException('Email này đã có hồ sơ ứng tuyển cho vị trí này. Hãy mở hồ sơ hiện có thay vì tải trùng.');
    const record=await this.db.one('INSERT INTO candidates(job_id,name,email,cv_filename,cv_text) VALUES($1,$2,$3,$4,$5) RETURNING id',[jobId,name,email,clean(filename,255),contents.slice(0,100000)]);
    await this.db.event('candidate',`Đã tải CV của ${name}`,record!.id);

    // Chế độ PRO: webhook tiếp nhận CV và kích hoạt AI qua n8n, không gửi nguyên CV qua webhook.
    if(process.env.AUTOMATION_PRO_ENABLED==='true') {
      await this.dispatch('cv-duplicate-check',{candidateId:record!.id,jobId,email});
      await this.dispatch('cv-normalize',{candidateId:record!.id});
      await this.dispatch('cv-intake',{candidateId:record!.id});
      const screening=await this.dispatch('ai-screening',{candidateId:record!.id});
      if(screening.ok) {
        return (await this.candidates()).find(x=>x.id===record!.id); // pending; n8n xử lý bất đồng bộ
      }
      await this.db.event('automation','Workflow AI Screening chưa hoạt động; Backend phân tích trực tiếp (AI thật).',record!.id);
    }
    return this.analyze(record!.id);
  }
  async analyze(id:string) {
    if(!uuid(id))throw new BadRequestException('Mã ứng viên không hợp lệ.');
    if(this.processing.has(id))return (await this.candidates()).find(x=>x.id===id);
    this.processing.add(id);
    try {
    const c=await this.db.one('SELECT c.*,j.title,j.description,j.requirements FROM candidates c JOIN jobs j ON j.id=c.job_id WHERE c.id=$1',[id]);
    if(!c)throw new NotFoundException('Không tìm thấy ứng viên.');
    await this.db.rows("UPDATE candidates SET ai_status='pending',ai_error=NULL,score=NULL,ai_summary=NULL,ai_strengths='[]'::jsonb,ai_gaps='[]'::jsonb,ai_skills='[]'::jsonb WHERE id=$1",[id]);
    try {
      const r=await this.groq.review(c,c.cv_text);
      await this.db.rows("UPDATE candidates SET ai_status='ready',score=$2,ai_summary=$3,ai_strengths=$4::jsonb,ai_gaps=$5::jsonb,ai_skills=$6::jsonb,ai_confidence=$7,analyzed_at=now() WHERE id=$1",[id,r.score,r.summary,JSON.stringify(r.strengths),JSON.stringify(r.gaps),JSON.stringify(r.skills),r.confidence]);
      await this.db.event('ai',`Groq phân tích CV ${c.name}: ${r.score}/100`,id);
      if(process.env.AUTOMATION_PRO_ENABLED==='true') {
        await this.dispatch('candidate-ranking',{candidateId:id,jobId:c.job_id});
        await this.dispatch('job-match',{candidateId:id});
        await this.dispatch('status-notify',{candidateId:id});
      }
    } catch(e:any) {
      const msg=clean(e?.response?.message || e?.message || 'Không thể kết nối Groq',500);
      await this.db.rows("UPDATE candidates SET ai_status='error',ai_error=$2 WHERE id=$1",[id,msg]);
      await this.db.event('ai',`Groq không phân tích được CV ${c.name}: ${msg}`,id);
    }
    return (await this.candidates()).find(x=>x.id===id);
    } finally {this.processing.delete(id);}
  }
  async interviews(){return this.db.rows(`SELECT i.*,c.name AS candidate_name,c.email AS candidate_email,c.score AS candidate_score,j.title AS job_title FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=c.job_id ORDER BY i.starts_at DESC`);}
  async schedule(data:any) {
    if(process.env.AUTOMATION_PRO_ENABLED==='true') {
      const dispatched=await this.dispatch('interview-schedule',data);
      const candidateId=clean(data?.candidateId,60),startsAt=clean(data?.startsAt,100);
      const existing=uuid(candidateId)&&Number.isFinite(Date.parse(startsAt))
        ? await this.db.one(`SELECT i.*,c.name AS candidate_name,c.email AS candidate_email,j.title AS job_title
            FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=c.job_id
            WHERE i.candidate_id=$1 AND i.starts_at=$2::timestamptz ORDER BY i.created_at DESC LIMIT 1`,[candidateId,new Date(startsAt)])
        : undefined;
      if(existing) return {...existing,automation:{ok:existing.email_status==='sent',emailStatus:existing.email_status,message:existing.email_status==='sent'?'Workflow n8n đã tạo lịch và Gmail xác nhận gửi thư.':(existing.email_error||'Lịch đã tạo; kiểm tra trạng thái email trong ứng dụng/n8n.'),aiInterviewGuide:dispatched.result?.aiInterviewGuide||[]}};
      if(dispatched.ok) {
        await this.db.event('automation','Workflow đặt lịch trả thành công nhưng không tìm thấy bản ghi; backend sẽ thử quy trình dự phòng.');
      } else {
        await this.db.event('automation',`Workflow đặt lịch chưa sẵn sàng; dùng backend dự phòng: ${clean(dispatched.message,180)}`);
      }
    }
    return this.createSchedule(data);
  }
  async scheduleByWorkflow(data:any) { return this.createSchedule(data); }
  private async createSchedule(data:any) {
    const candidateId=clean(data?.candidateId,60),startsAt=clean(data?.startsAt,100),mode=data?.mode==='onsite'?'onsite':'online';
    const minutes=Number(data?.durationMinutes||30);
    if(!uuid(candidateId)||!Number.isFinite(Date.parse(startsAt))||new Date(startsAt).getTime()<Date.now()+60000)throw new BadRequestException('Chọn ứng viên và thời gian phỏng vấn trong tương lai.');
    if(!Number.isInteger(minutes)||minutes<15||minutes>180)throw new BadRequestException('Thời lượng phải từ 15–180 phút.');
    const c=await this.db.one(`SELECT c.*,j.title AS job_title,j.description AS job_description,j.requirements AS job_requirements
      FROM candidates c JOIN jobs j ON j.id=c.job_id WHERE c.id=$1`,[candidateId]);
    if(!c||c.ai_status!=='ready')throw new BadRequestException('Chỉ đặt lịch cho ứng viên đã phân tích thành công.');
    const link=clean(data?.meetingLink,2000),notes=clean(data?.notes,2000);
    if(mode==='online' && link && !/^https:\/\//i.test(link))throw new BadRequestException('Đường dẫn phỏng vấn trực tuyến phải bắt đầu bằng https://');
    const conflict=await this.db.one(`SELECT id FROM interviews WHERE candidate_id=$1 AND status='scheduled'
      AND tstzrange(starts_at,starts_at + duration_minutes * interval '1 minute','[)') &&
          tstzrange($2::timestamptz,$2::timestamptz + $3 * interval '1 minute','[)') LIMIT 1`,[candidateId,new Date(startsAt),minutes]);
    if(conflict)throw new ConflictException('Ứng viên đã có lịch phỏng vấn trùng thời gian. Hãy chọn khung giờ khác.');
    const interview=await this.db.one('INSERT INTO interviews(candidate_id,starts_at,duration_minutes,mode,meeting_link,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[candidateId,new Date(startsAt),minutes,mode,link,notes]);
    await this.db.event('interview',`Đã đặt lịch phỏng vấn cho ${c.name}`,interview!.id);
    const [automation, aiInterviewGuide]=await Promise.all([
      this.triggerAutomation(interview!.id),
      this.groq.generateInterviewGuide(
        {title:c.job_title,requirements:c.job_requirements},
        {ai_summary:String(c.ai_summary||'').replaceAll(String(c.name||''),'[ứng viên]'),ai_skills:c.ai_skills,ai_gaps:c.ai_gaps}
      ).catch(async (error:any)=>{
        await this.db.event('ai',`Không tạo được gợi ý phỏng vấn bằng Groq: ${clean(error?.message||error,180)}`,interview!.id);
        return [] as string[];
      })
    ]);
    if(aiInterviewGuide.length) await this.db.event('ai',`Groq tạo ${aiInterviewGuide.length} câu hỏi gợi ý phỏng vấn theo vị trí và kỹ năng hồ sơ.`,interview!.id);
    return {...interview,automation,aiInterviewGuide};
  }
  async triggerAutomation(interviewId:string) {
    const webhook=process.env.N8N_WEBHOOK_URL;
    if(!webhook)return {ok:false,message:'Chưa cấu hình N8N_WEBHOOK_URL'};
    try {
      const res=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json','x-automation-token':process.env.WORKFLOW_SHARED_SECRET||''},body:JSON.stringify({interviewId}),signal:AbortSignal.timeout(30000)});
      if(!res.ok)throw new Error(`n8n HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
      const latest=await this.db.one('SELECT email_status,email_error FROM interviews WHERE id=$1',[interviewId]);
      return {ok:latest?.email_status==='sent',message:latest?.email_status==='sent'?'n8n đã chạy và Gmail đã gửi email.':'n8n nhận yêu cầu. Hãy kiểm tra Executions và cấu hình SMTP.',emailStatus:latest?.email_status};
    } catch(e:any) {
      await this.db.event('automation',`Không gọi được webhook n8n: ${clean(e.message,200)}`,interviewId);
      return {ok:false,message:`Không kích hoạt được n8n: ${clean(e.message,200)}. Nhập/publish workflow trước, sau đó nhấn Gửi lại.`};
    }
  }
  async retry(id:string) {
    if(!uuid(id))throw new BadRequestException('Mã lịch phỏng vấn không hợp lệ.');
    const found=await this.db.one('SELECT email_status,status FROM interviews WHERE id=$1',[id]);
    if(!found)throw new NotFoundException('Không tìm thấy lịch phỏng vấn.');
    if(found.status==='cancelled')throw new ConflictException('Lịch đã hủy.');
    if(found.email_status==='sent')throw new ConflictException('Email đã gửi thành công, không gửi trùng.');
    return this.triggerAutomation(id);
  }
  async sendInviteByWorkflow(id:string) {
    if(!uuid(id))throw new BadRequestException('Mã lịch không hợp lệ.');
    const i=await this.db.one(`SELECT i.*,c.name AS candidate_name,c.email AS candidate_email,j.title AS job_title FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=c.job_id WHERE i.id=$1`,[id]);
    if(!i)throw new NotFoundException('Không tìm thấy lịch phỏng vấn.');
    if(i.status==='cancelled')throw new ConflictException('Lịch đã hủy.');
    if(i.email_status==='sent')return {sent:true,alreadySent:true};
    const claimed=await this.db.one(`UPDATE interviews SET email_status='sending',email_attempt_started_at=now() WHERE id=$1
      AND (email_status IN ('pending','failed') OR (email_status='sending' AND email_attempt_started_at<now()-interval '3 minutes')) RETURNING id`,[id]);
    if(!claimed) return {sent:false,processing:true,message:'Email đang được xử lý, không gửi trùng.'};
    try {
      const delivery=await this.mail.sendInvite(i);
      await this.db.rows("UPDATE interviews SET email_status='sent',email_error=NULL,email_sent_at=now() WHERE id=$1",[id]);
      await this.db.event('email',`n8n → Gmail đã gửi thư mời phỏng vấn tới ${i.candidate_email}${delivery.aiAssisted?' (Groq hỗ trợ soạn nội dung)':' (dùng nội dung chuẩn)'}`,id);
      await this.record('interview-invite',id,'success',`SMTP Gmail gửi thư mời; Groq ${delivery.aiAssisted?'đã soạn nội dung':'không khả dụng, dùng nội dung chuẩn'}`);
      return {sent:true,messageId:delivery.messageId,aiAssisted:delivery.aiAssisted};
    }catch(e:any){
      const msg=clean(e?.response?.message||e?.message||'SMTP lỗi',300);
      await this.db.rows("UPDATE interviews SET email_status='failed',email_error=$2 WHERE id=$1",[id,msg]);
      await this.db.event('email',`Gửi Gmail thất bại: ${msg}`,id);
      await this.record('interview-invite',id,'failed',msg);
      throw e;
    }
  }

private async record(workflow:string, refId:string, status:'received'|'success'|'failed', detail:string) {
  try { await this.db.rows('INSERT INTO automation_runs(workflow,ref_id,status,detail) VALUES($1,$2,$3,$4)',[workflow,refId,status,clean(detail,400)]); }
  catch(e:any){this.logger.warn(`automation_runs chưa migrate: ${e.message}`);}
}
async workflowRuns(){return this.db.rows('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 80');}
private async dispatch(workflow:string, body:any):Promise<{ok:boolean;message:string;result?:any}> {
  const paths:Record<string,string>={
    'cv-intake':'recruitment-cv-intake','ai-screening':'recruitment-ai-screening',
    'candidate-ranking':'recruitment-ranking','interview-invite':'recruitment-invite',
    'recruitment-followup':'recruitment-followup','interview-schedule':'recruitment-schedule-interview','cv-duplicate-check':'recruitment-duplicate-check',
    'cv-normalize':'recruitment-cv-normalize','job-match':'recruitment-job-match',
    'status-notify':'recruitment-status-notify'
  };
  const webhookPath=paths[workflow];
  const host=process.env.N8N_INTERNAL_URL||'http://n8n:5678';
  if(!webhookPath)return {ok:false,message:'Workflow không tồn tại.'};
  const id=clean(body.candidateId||body.interviewId||body.jobId||'followup',60);
  try {
    // n8n chỉ nhận ID; CV, API key, mật khẩu không đi qua webhook.
    const res=await fetch(`${host}/webhook/${webhookPath}`,{
      method:'POST',headers:{'content-type':'application/json', 'x-automation-token':process.env.WORKFLOW_SHARED_SECRET||''},
      body:JSON.stringify(body),signal:AbortSignal.timeout(
        workflow==='interview-schedule'?50000:
        workflow==='interview-invite'?35000:
        workflow==='ai-screening'?60000:
        workflow==='recruitment-followup'?60000:
        workflow==='status-notify'?30000:
        workflow==='candidate-ranking'?30000:8000
      )
    });
    if(!res.ok) throw new Error(`n8n HTTP ${res.status}: ${(await res.text()).slice(0,160)}`);
    const responseBody=await res.json().catch(()=>({}));
    const result=responseBody?.result;
    await this.record(workflow,id,'received','n8n đã nhận sự kiện, xem Executions để xác nhận kết quả.');
    return {ok:true,message:'Đã chuyển yêu cầu đến n8n. Kiểm tra Executions để xem kết quả.',result};
  }catch(e:any){
    const msg=clean(e?.message,250);
    await this.record(workflow,id,'failed',msg);
    this.logger.warn(`${workflow}: ${msg}`);
    return {ok:false,message:`${workflow}: ${msg}`};
  }
}
async checkDuplicateCv(v:any) {
  const jobId=clean(v?.jobId,60),email=clean(v?.email,260).toLowerCase(),candidateId=clean(v?.candidateId,60);
  if(!uuid(jobId))throw new BadRequestException('jobId không hợp lệ.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new BadRequestException('Email không hợp lệ.');
  if(candidateId&&!uuid(candidateId))throw new BadRequestException('candidateId không hợp lệ.');
  const existing=await this.db.one(`SELECT id FROM candidates WHERE job_id=$1 AND lower(email)=lower($2)
    AND ($3::uuid IS NULL OR id<>$3::uuid) ORDER BY created_at DESC LIMIT 1`,[jobId,email,candidateId||null]);
  await this.record('cv-duplicate-check',candidateId||jobId,'success',existing?'Phát hiện email đã có hồ sơ cùng vị trí':'Không phát hiện hồ sơ trùng email');
  return {duplicate:!!existing,jobId,candidateId:candidateId||null,existingCandidateId:existing?.id||null};
}
async normalizeCv(id:string) {
  if(!uuid(id))throw new BadRequestException('candidateId không hợp lệ.');
  const c=await this.db.one('SELECT id,cv_text FROM candidates WHERE id=$1',[id]);
  if(!c)throw new NotFoundException('Không có ứng viên.');
  const before=String(c.cv_text||'');
  const normalized=before.replace(/\r\n?/g,'\n').replace(/[\t\u00a0]+/g,' ').split('\n').map((line:string)=>line.replace(/[ ]{2,}/g,' ').trim()).join('\n').replace(/\n{3,}/g,'\n\n').trim();
  await this.db.rows('UPDATE candidates SET cv_text=$2 WHERE id=$1',[id,normalized]);
  await this.db.event('automation',`n8n chuẩn hóa nội dung CV (${normalized.length} ký tự)`,id);
  await this.record('cv-normalize',id,'success',`Chuẩn hóa CV: ${before.length} → ${normalized.length} ký tự`);
  return {candidateId:id,originalChars:before.length,normalizedChars:normalized.length,changed:before!==normalized};
}
async jobMatchReport(id:string) {
  if(!uuid(id))throw new BadRequestException('candidateId không hợp lệ.');
  const c=await this.db.one(`SELECT c.id,c.job_id,c.name,c.ai_status,c.score,c.ai_summary,c.ai_strengths,c.ai_gaps,c.ai_skills,c.ai_confidence,c.ai_error,
    j.title AS job_title,j.requirements FROM candidates c JOIN jobs j ON j.id=c.job_id WHERE c.id=$1`,[id]);
  if(!c)throw new NotFoundException('Không có ứng viên.');
  await this.record('job-match',id,c.ai_status==='ready'?'success':'received',c.ai_status==='ready'?'Đã tạo báo cáo đối sánh CV/JD':'Chưa có kết quả AI; cần phân tích CV trước');
  return {candidateId:c.id,jobId:c.job_id,candidateName:c.name,jobTitle:c.job_title,status:c.ai_status,ready:c.ai_status==='ready',fitScore:c.score,summary:c.ai_summary,strengths:c.ai_strengths,gaps:c.ai_gaps,skills:c.ai_skills,confidence:c.ai_confidence,error:c.ai_error,jobRequirements:c.requirements};
}
async notifyCandidateStatus(id:string) {
  if(!uuid(id))throw new BadRequestException('candidateId không hợp lệ.');
  const c=await this.db.one(`SELECT c.id,c.name,c.email,c.ai_status,c.score,c.ai_summary,c.ai_error,j.title AS job_title
    FROM candidates c JOIN jobs j ON j.id=c.job_id WHERE c.id=$1`,[id]);
  if(!c)throw new NotFoundException('Không có ứng viên.');
  if(c.ai_status==='pending')throw new ConflictException('CV đang chờ phân tích; chưa gửi thông báo trạng thái.');
  try {
    const messageId=await this.mail.sendCandidateStatusNotification(c);
    await this.db.event('notification',`Đã gửi thông báo trạng thái AI cho bộ phận tuyển dụng: ${c.name}`,id);
    await this.record('status-notify',id,'success',`Đã gửi email thông báo trạng thái ${c.ai_status}`);
    return {sent:true,messageId,candidateId:id,status:c.ai_status};
  } catch(e:any) {
    const msg=clean(e?.message||'Không gửi được thông báo',300);
    await this.record('status-notify',id,'failed',msg);
    throw e;
  }
}
async dailyRecruitmentReport() {
  const [stats]=await this.db.rows(`SELECT
    (SELECT count(*) FROM jobs WHERE status='open')::int AS "openJobs",
    (SELECT count(*) FROM candidates)::int AS candidates,
    (SELECT count(*) FROM candidates WHERE ai_status='ready')::int AS analyzed,
    (SELECT count(*) FROM interviews WHERE status='scheduled')::int AS interviews,
    (SELECT count(*) FROM interviews WHERE email_status='sent')::int AS "emailsSent",
    (SELECT count(*) FROM interviews WHERE reminder_status='sent')::int AS "remindersSent"`);
  let emailSent=false,messageId:string|undefined;
  try { messageId=await this.mail.sendRecruitmentReport(stats);emailSent=true; }
  catch(e:any) { await this.db.event('report',`Đã tạo báo cáo nhưng chưa gửi email: ${clean(e?.message||'SMTP chưa cấu hình',220)}`); }
  await this.db.event('report',`Báo cáo định kỳ: ${stats.candidates} hồ sơ, ${stats.analyzed} đã phân tích, ${stats.emailsSent} thư mời đã gửi`);
  await this.record('daily-report','scheduled','success',`Báo cáo đã tạo; email ${emailSent?'đã gửi':'chưa gửi'}`);
  return {ok:true,report:stats,emailSent,messageId};
}
async logAutomationError(v:any) {
  const workflow=clean(v?.workflow||'unknown-workflow',120),executionId=clean(v?.executionId||'',100);
  const severity=['critical','error','warning'].includes(clean(v?.severity,20))?clean(v.severity,20):'error';
  const detail=clean(v?.error||'n8n báo lỗi không có nội dung',800);
  const refId=executionId||workflow;
  await this.db.event('automation-error',`[${severity}] ${workflow}: ${detail}`,refId);
  await this.record(`n8n-error:${workflow}`,refId,'failed',detail);
  let alertSent=false;
  if(severity==='critical') {
    try { await this.mail.sendAutomationAlert({workflow,executionId,severity,error:detail});alertSent=true; }
    catch(e:any) { await this.db.event('automation-error',`Không gửi được email cảnh báo: ${clean(e?.message||'SMTP lỗi',200)}`,refId); }
  }
  return {recorded:true,alertSent,workflow,executionId,severity};
}
async verifyCv(id:string) {
  if(!uuid(id))throw new BadRequestException('candidateId không hợp lệ');
  const candidate=await this.db.one('SELECT id,job_id,name,length(cv_text) AS chars,cv_verified_at FROM candidates WHERE id=$1',[id]);
  if(!candidate)throw new NotFoundException('Không có ứng viên');
  if(candidate.chars<100)throw new BadRequestException('CV không đủ nội dung');
  if(!candidate.cv_verified_at){
    await this.db.rows('UPDATE candidates SET cv_verified_at=now() WHERE id=$1',[id]);
    await this.db.event('automation',`n8n đã xác thực CV: ${candidate.name}`,id);
  }
  await this.record('cv-intake',id,'success',`Đã xác thực CV (${candidate.chars} ký tự)`);
  return {verified:true,candidateId:id,jobId:candidate.job_id};
}
async screenByWorkflow(id:string){
  const result=await this.analyze(id);
  await this.record('ai-screening',id,result?.ai_status==='ready'?'success':'failed',
    result?.ai_status==='ready'?`Groq thật: ${result.score}/100`:result?.ai_error||'Chưa có kết quả AI');
  if(result?.ai_status!=='ready')throw new Error(result?.ai_error||'Groq chưa đánh giá được');
  return {candidateId:id,score:result.score,status:result.ai_status};
}
async recomputeRanking(jobId:string) {
  if(!uuid(jobId))throw new BadRequestException('jobId không hợp lệ');
  const job=await this.db.one('SELECT id FROM jobs WHERE id=$1',[jobId]);
  if(!job)throw new NotFoundException('Không tìm thấy tin tuyển dụng');
  // Dùng một transaction để luôn có bảng xếp hạng nhất quán cho từng vị trí.
  const client=await this.db.pool.connect();
  let count=0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[jobId]);
    await client.query('DELETE FROM candidate_rankings WHERE job_id=$1',[jobId]);
    const candidates=await client.query(`SELECT id,score FROM candidates WHERE job_id=$1 AND ai_status='ready' AND score IS NOT NULL ORDER BY score DESC,analyzed_at ASC,id ASC`,[jobId]);
    for(const c of candidates.rows){
      count++;
      await client.query('INSERT INTO candidate_rankings(candidate_id,job_id,rank_position,score) VALUES($1,$2,$3,$4)',[c.id,jobId,count,c.score]);
    }
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}
  finally{client.release();}
  await this.record('candidate-ranking',jobId,'success',`Đã cập nhật xếp hạng ${count} ứng viên`);
  await this.db.event('automation',`n8n cập nhật bảng xếp hạng: ${count} ứng viên`,jobId);
  return {jobId,ranked:count};
}
async rerankByAdmin(jobId:string){
  const result=await this.dispatch('candidate-ranking',{jobId});
  return result;
}
async followupByAdmin(){return this.dispatch('recruitment-followup',{manual:true});}
async processReminders(){
  // Gửi trước 24 giờ, chỉ các email mời đã gửi và lịch chưa hết hạn.
  const due=await this.db.rows(`SELECT i.id FROM interviews i WHERE i.status='scheduled' AND i.email_status='sent'
    AND i.starts_at>now()+interval '10 minutes' AND i.starts_at<=now()+interval '24 hours'
    AND i.reminder_status IN ('pending','failed') AND i.reminder_sent_at IS NULL ORDER BY i.starts_at LIMIT 20`);
  let sent=0,failed=0,aiAssisted=0;
  for(const item of due){
    const claimed=await this.db.one(`UPDATE interviews SET reminder_status='sending',reminder_error=NULL WHERE id=$1
      AND reminder_status IN ('pending','failed') AND reminder_sent_at IS NULL RETURNING id`,[item.id]);
    if(!claimed)continue;
    const interview=await this.db.one(`SELECT i.*,c.name AS candidate_name,c.email AS candidate_email,j.title AS job_title
      FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=c.job_id WHERE i.id=$1`,[item.id]);
    try{
      const delivery=await this.mail.sendReminder(interview);
      await this.db.rows("UPDATE interviews SET reminder_status='sent',reminder_sent_at=now(),reminder_error=NULL WHERE id=$1",[item.id]);
      await this.db.event('email',`n8n đã gửi thư nhắc lịch cho ${interview.candidate_name}${delivery.aiAssisted?' (Groq hỗ trợ soạn nội dung)':' (dùng nội dung chuẩn)'}`,item.id);
      if(delivery.aiAssisted)aiAssisted++;
      sent++;
    }catch(e:any){
      const msg=clean(e?.message||'SMTP lỗi',250);
      await this.db.rows("UPDATE interviews SET reminder_status='failed',reminder_error=$2 WHERE id=$1",[item.id,msg]);
      await this.db.event('email',`Không gửi được email nhắc lịch: ${msg}`,item.id);
      failed++;
    }
  }
  await this.record('recruitment-followup','scheduled','success',`Đã nhắc ${sent}, lỗi ${failed}, Groq hỗ trợ ${aiAssisted}, hồ sơ đến hạn ${due.length}`);
  return {due:due.length,sent,failed,aiAssisted,window:'10 phút đến 24 giờ trước phỏng vấn'};
}

  async events(){return this.db.rows('SELECT * FROM events ORDER BY created_at DESC LIMIT 100');}
}
