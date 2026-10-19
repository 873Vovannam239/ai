import { Module } from '@nestjs/common';
import { AppController } from './controller';
import { AppService } from './service';
import { DbService } from './db';
import { GroqService } from './groq';
import { MailService } from './mail';
@Module({ controllers: [AppController], providers: [AppService, DbService, GroqService, MailService] })
export class AppModule {}
