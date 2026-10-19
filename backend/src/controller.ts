import { Controller, Get, Post, Body, Query, Param, Headers, UnauthorizedException, BadRequestException, UploadedFile, UseInterceptors, Injectable, CanActivate, ExecutionContext, UseGuards, HttpCode } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppService } from './service';
import * as mammoth from 'mammoth';
// pdf-parse v1 is a CommonJS callable module.
const pdfParse = require('pdf-parse') as (input:Buffer) => Promise<{text:string}>;
@Injectable()
class AdminGuard implements CanActivate {
  canActivate(ctx:ExecutionContext) {
    const req=ctx.switchToHttp().getRequest();
    const expected=process.env.ADMIN_API_KEY;
    if(!expected || req.headers['x-admin-token'] !== expected)throw new UnauthorizedException('Truy cập quản trị bị từ chối.');
    return true;
  }
}
@Injectable()
class WorkflowGuard implements CanActivate {
  canActivate(ctx:ExecutionContext) {
    const req=ctx.switchToHttp().getRequest();
    const expected=process.env.WORKFLOW_SHARED_SECRET;
    if(!expected || req.headers['x-flow-token']!==expected)throw new UnauthorizedException('Khóa workflow không hợp lệ.');
    return true;
  }
}
@Controller()
export class AppController {
  constructor(private readonly svc:AppService){}
  @Get('health') health(){return this.svc.health();}
  @Get('dashboard') @UseGuards(AdminGuard) dashboard(){return this.svc.dashboard();}
  @Get('jobs') @UseGuards(AdminGuard) jobs(){return this.svc.jobs();}
  @Post('jobs') @UseGuards(AdminGuard) job(@Body() v:any){return this.svc.createJob(v);}
  @Get('candidates') @UseGuards(AdminGuard) candidates(@Query('jobId') id?:string){return this.svc.candidates(id);}
  @Post('candidates/upload') @UseGuards(AdminGuard)
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:5*1024*1024}}))
  async upload(@UploadedFile() file:Express.Multer.File,@Body() body:any) {
    if(!file)throw new BadRequestException('Hãy chọn tệp CV PDF hoặc DOCX.');
    const filename=file.originalname||'';
    const ext=filename.toLowerCase().endsWith('.pdf')?'pdf':filename.toLowerCase().endsWith('.docx')?'docx':'';
    if(!ext)throw new BadRequestException('Chỉ hỗ trợ CV PDF hoặc DOCX.');
    if(ext==='pdf'&&file.buffer.slice(0,4).toString()!=='%PDF')throw new BadRequestException('Tệp không phải PDF hợp lệ.');
    if(ext==='docx'&&file.buffer.slice(0,2).toString()!=='PK')throw new BadRequestException('Tệp không phải DOCX hợp lệ.');
    let text='';
    try { text=ext==='pdf'?(await pdfParse(file.buffer)).text:(await mammoth.extractRawText({buffer:file.buffer})).value; }
    catch{ throw new BadRequestException('Không đọc được CV. PDF scan ảnh chưa được hỗ trợ OCR; dùng PDF có văn bản hoặc DOCX.'); }
    return this.svc.upload(body.jobId,body.name,body.email,filename,text);
  }
  @Post('candidates/:id/analyze') @UseGuards(AdminGuard) @HttpCode(200) analyze(@Param('id') id:string){return this.svc.analyze(id);}
  @Get('interviews') @UseGuards(AdminGuard) interviews(){return this.svc.interviews();}
  @Post('interviews') @UseGuards(AdminGuard) interview(@Body() v:any){return this.svc.schedule(v);}
  @Post('interviews/:id/retry') @UseGuards(AdminGuard) @HttpCode(200) retry(@Param('id') id:string){return this.svc.retry(id);}
  @Get('events') @UseGuards(AdminGuard) events(){return this.svc.events();}
  @Get('automation/runs') @UseGuards(AdminGuard) runs(){return this.svc.workflowRuns();}
  @Post('automation/rerank') @UseGuards(AdminGuard) @HttpCode(200) rerank(@Body() v:any){return this.svc.rerankByAdmin(v.jobId);}
  @Post('automation/followup') @UseGuards(AdminGuard) @HttpCode(200) followup(){return this.svc.followupByAdmin();}
  @Post('automation/verify-cv') @UseGuards(WorkflowGuard) @HttpCode(200) verify(@Body() v:any){return this.svc.verifyCv(v.candidateId);}
  @Post('automation/check-duplicate-cv') @UseGuards(WorkflowGuard) @HttpCode(200) duplicateCv(@Body() v:any){return this.svc.checkDuplicateCv(v);}
  @Post('automation/normalize-cv') @UseGuards(WorkflowGuard) @HttpCode(200) normalizeCv(@Body() v:any){return this.svc.normalizeCv(v.candidateId);}
  @Post('automation/job-match') @UseGuards(WorkflowGuard) @HttpCode(200) jobMatch(@Body() v:any){return this.svc.jobMatchReport(v.candidateId);}
  @Post('automation/schedule-interview') @UseGuards(WorkflowGuard) @HttpCode(200) scheduleByWorkflow(@Body() v:any){return this.svc.scheduleByWorkflow(v);}
  @Post('automation/notify-candidate-status') @UseGuards(WorkflowGuard) @HttpCode(200) notifyStatus(@Body() v:any){return this.svc.notifyCandidateStatus(v.candidateId);}
  @Post('automation/daily-report') @UseGuards(WorkflowGuard) @HttpCode(200) dailyReport(){return this.svc.dailyRecruitmentReport();}
  @Post('automation/log-error') @UseGuards(WorkflowGuard) @HttpCode(200) logError(@Body() v:any){return this.svc.logAutomationError(v);}
  @Post('automation/screen-cv') @UseGuards(WorkflowGuard) @HttpCode(200) screening(@Body() v:any){return this.svc.screenByWorkflow(v.candidateId);}
  @Post('automation/recalculate-ranking') @UseGuards(WorkflowGuard) @HttpCode(200) ranking(@Body() v:any){return this.svc.recomputeRanking(v.jobId);}
  @Post('automation/send-reminders') @UseGuards(WorkflowGuard) @HttpCode(200) reminders(){return this.svc.processReminders();}

  @Post('automation/send-invite') @UseGuards(WorkflowGuard) @HttpCode(200) send(@Body() v:any){return this.svc.sendInviteByWorkflow(v.interviewId);}
}
