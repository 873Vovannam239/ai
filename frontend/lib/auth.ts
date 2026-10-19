import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
const COOKIE='recruitment_session';
const secret=()=>process.env.ADMIN_SESSION_SECRET||'';
const signature=(value:string)=>createHmac('sha256',secret()).update(value).digest('base64url');
export function createSession(){
  const payload=Buffer.from(JSON.stringify({exp:Date.now()+1000*60*60*12})).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export async function validSession(){
  const value=(await cookies()).get(COOKIE)?.value;
  if(!value || !secret())return false;
  const [payload,sig,...extra]=value.split('.');
  if(!payload||!sig||extra.length)return false;
  const a=Buffer.from(signature(payload)); const b=Buffer.from(sig);
  if(a.length!==b.length || !timingSafeEqual(a,b))return false;
  try{const obj=JSON.parse(Buffer.from(payload,'base64url').toString());return typeof obj.exp==='number'&&obj.exp>Date.now();}catch{return false;}
}
export const sessionCookie=COOKIE;
