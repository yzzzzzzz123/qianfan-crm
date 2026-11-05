import { exportTrialData, resetTrialData } from './browser-api.mjs';
const notice=document.createElement('aside');notice.id='trial-notice';notice.setAttribute('aria-label','试用说明');
notice.innerHTML='<span><b>独立试用版</b> · 数据只保存在当前浏览器，各人互不共享。请仅使用测试资料。</span><div><button id="trial-export">导出测试数据</button><button id="trial-reset">恢复演示数据</button></div>';
document.body.prepend(notice);
document.querySelector('#trial-export').addEventListener('click',()=>{
 const blob=new Blob([JSON.stringify({format:'qianfan-crm-trial-v2',exportedAt:new Date().toISOString(),database:exportTrialData()})],{type:'application/json'});
 const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='千帆CRM-试用备份-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
document.querySelector('#trial-reset').addEventListener('click',()=>{if(confirm('将清空此浏览器的试用记录并恢复演示数据，其他人的数据不受影响。继续吗？'))resetTrialData();});
await import('./public/app.js');
