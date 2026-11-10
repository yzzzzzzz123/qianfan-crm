import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function prepareAI(root) {
  const file=path.join(root,'.private/ai.json');
  if (!fs.existsSync(file) || process.env.AI_API_KEY) return;
  const profile=JSON.parse(fs.readFileSync(file,'utf8'));
  if(profile.provider!=='zimaocloud'||profile.model!=='deepseek-v4-1-flash'||profile.base_url!=='https://aiclub.zimaocloud.com/model/openApi/v1') throw new Error('CRM AI配置须使用紫猫云 DeepSeek V4.1 Flash');
  if(process.platform!=='win32') throw new Error('此私有AI配置使用Windows DPAPI；其他系统请通过AI_API_KEY提供凭据');
  try {
    const key=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'local/read-ai-key.ps1'),'-ConfigPath',file],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
    if(!/^[!-~]{16,2048}$/.test(key)) throw new Error();
    process.env.AI_API_KEY=key;
    if(profile.protected_search_key&&!process.env.PPIO_SEARCH_API_KEY){
      const searchKey=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'local/read-ai-key.ps1'),'-ConfigPath',file,'-Field','protected_search_key'],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
      if(!/^[!-~]{16,2048}$/.test(searchKey))throw new Error();
      process.env.PPIO_SEARCH_API_KEY=searchKey;
    }
  } catch { throw new Error('无法解密CRM私有AI配置，请使用保存该配置的Windows用户运行'); }
}
