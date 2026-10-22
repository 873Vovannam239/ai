import { NextRequest, NextResponse } from 'next/server';
import { validSession } from '@/lib/auth';
export const runtime='nodejs';
async function proxy(req:NextRequest,ctx:{params:Promise<{path:string[]}>}){
  if(!await validSession())return NextResponse.json({message:'Phiên quản trị đã hết hạn, hãy đăng nhập lại.'},{status:401});
  const {path}=await ctx.params;
  if(!path?.length || !['health','dashboard','jobs','candidates','interviews','events','automation'].includes(path[0]) || path.some(x=>x==='..'||x.includes('/')))return NextResponse.json({message:'Đường dẫn không hợp lệ.'},{status:400});
  const base=process.env.INTERNAL_API_URL||'http://api:4000/api';
  const url=new URL(`${base}/${path.map(encodeURIComponent).join('/')}`);
  req.nextUrl.searchParams.forEach((value,key)=>url.searchParams.append(key,value));
  const headers:Record<string,string>={'x-admin-token':process.env.ADMIN_API_KEY||''};
  const ct=req.headers.get('content-type'); if(ct)headers['content-type']=ct;
  try{
    const body=req.method==='GET'||req.method==='HEAD'?undefined:await req.arrayBuffer();
    const res=await fetch(url,{method:req.method,headers,body,cache:'no-store',signal:AbortSignal.timeout(85000)});
    return new Response(await res.text(),{status:res.status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  }catch(e:any){return NextResponse.json({message:'Không kết nối được NestJS API: '+String(e.message||'')},{status:502});}
}
export const GET=proxy; export const POST=proxy; export const PATCH=proxy; export const DELETE=proxy;
