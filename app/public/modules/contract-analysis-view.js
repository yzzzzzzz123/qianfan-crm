import {esc,plainMoney,dateLabel,actionButton as button} from '../ui.js';
const optional=value=>value==null?'待补充':plainMoney(value);
export function contractAnalysisPanel(S,c){
 if(S.actor.role==='pm')return '';
 const a=c.contract_analysis,ready=a?.state==='ready',v=a?.result;
 return `<section class="detail-section contract-ai-analysis"><div class="section-head"><h3>合同附件 AI 提取</h3>${S.actor.role==='admin'&&(c.attachments||[]).length?button('重新提取','contract-extract',c.id,'secondary','note'):''}</div>${ready&&v?`<p class="prose">${esc(v.summary||'已读取原件，请核对金额及付款约定。')}</p><dl class="detail-facts"><div><dt>识别合同总金额</dt><dd>${optional(v.total_amount)}</dd></div><div><dt>原始文件</dt><dd>${esc(a.filename||'')}</dd></div></dl><div class="payment-list">${v.payment_stages.map(p=>`<div class="payment-line"><div><b>${esc(p.name)}</b><p>${optional(p.amount)} · ${dateLabel(p.due_date)}</p><p>${esc(p.condition||'')}</p><small>${esc(p.evidence||'')}</small></div></div>`).join('')||'<p class="muted">未识别出明确付款阶段</p>'}</div>${v.questions?.length?`<ul>${v.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul>`:''}<p class="muted">识别结果需核对，通过业务表单或 AI 接收确认后维护合同及收款计划。</p>`:`<p class="muted">${esc(a?.reason||'通过 AI 接收上传并关联合同原件后，将自动提取合同总金额和约定付款阶段。')}</p>`}</section>`;
}
