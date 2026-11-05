import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function prepareAI(root) {
  const file=path.join(root,'.private/ai.json');
  if (!fs.existsSync(file) || process.env.PPIO_API_KEY) return;
  const profile=JSON.parse(fs.readFileSync(file,'utf8'));
  if(profile.provider!=='ppio'||profile.model!=='qwen/qwen3.8-max'||profile.base_url!=='https://api.ppio.com/openai/v1') throw new Error('CRM AI配置须使用派欧云Qwen3.8 Max');
  if(process.platform!=='win32') throw new Error('此私有AI配置使用Windows DPAPI；其他系统请通过PPIO_API_KEY提供凭据');
  try {
    const key=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'local/read-ai-key.ps1'),'-ConfigPath',file],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
    if(!/^[!-~]{16,2048}$/.test(key)) throw new Error();
    process.env.PPIO_API_KEY=key;
  } catch { throw new Error('无法解密CRM私有AI配置，请使用保存该配置的Windows用户运行'); }
}
