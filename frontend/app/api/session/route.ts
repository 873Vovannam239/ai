import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createSession, validSession, sessionCookie } from '@/lib/auth';
export const runtime='nodejs';
export async function GET(){return NextResponse.json({authenticated:await validSession()});}
export async function POST(req:NextRequest){
  const {password}=await req.json().catch(()=>({password:''}));
  const real=process.env.ADMIN_PASSWORD||'';
  const a=Buffer.from(String(password||'')),b=Buffer.from(real);
  if(!real||a.length!==b.length||!timingSafeEqual(a,b))return NextResponse.json({message:'Sai mật khẩu quản trị.'},{status:401});
  const resp=NextResponse.json({authenticated:true});
  resp.cookies.set(sessionCookie,createSession(),{httpOnly:true,sameSite:'lax',secure:false,path:'/',maxAge:60*60*12});
  return resp;
}
export async function DELETE(){const resp=NextResponse.json({authenticated:false});resp.cookies.delete(sessionCookie);return resp;}
