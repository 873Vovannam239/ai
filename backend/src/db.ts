import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, QueryResultRow } from 'pg';
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  async rows<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }
  async one<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    return (await this.rows<T>(sql, params))[0];
  }
  async event(category: string, message: string, refId = '') {
    await this.rows('INSERT INTO events(category,message,ref_id) VALUES($1,$2,$3)', [category,message,refId]);
  }
  async onModuleDestroy() { await this.pool.end(); }
}
