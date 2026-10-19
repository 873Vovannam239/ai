import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'TalentFlow AI | Recruitment Agent',description:'Tuyển dụng thông minh với AI Groq thật, n8n và PostgreSQL'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="vi"><body>{children}</body></html>}
