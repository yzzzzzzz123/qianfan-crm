import {esc,actionButton as button} from '../ui.js';

export function salesAdvicePanel(S,o){
 if(S.actor.role==='pm')return '';
 const value=o.ai_advice,a=value?.advice;
 const list=(items,render)=>Array.isArray(items)&&items.length?`<ul>${items.map(v=>`<li>${render(v)}</li>`).join('')}</ul>`:'<p class="muted">本次未提供</p>';
 return `<section class="detail-section sales-advice"><div class="section-head"><h3>AI 阶段建议</h3>${S.actor.role!=='pm'?button(a?'重新分析':'分析下一步行动','opportunity-advice',o.id,'secondary','note'):''}</div>${a?`<p class="prose">${esc(a.stage_assessment||'')}</p><h4>下一步行动</h4>${list(a.next_actions,v=>`<b>${esc(v.action||'')}</b><p>${esc(v.purpose||'')}</p><small>优先级 ${esc(v.priority??'待定')} · ${esc(v.timing||'待确认时间')} · ${esc(v.success_signal||'待明确完成标准')}</small>`)}<h4>沟通建议</h4>${list(a.talk_tracks,v=>`<b>${esc(v.scenario||'')}</b><p>${esc(v.script||'')}</p>`)}<h4>需要准备的材料</h4>${list(a.materials,v=>esc(v))}<h4>风险与待补信息</h4>${list([...(a.risks||[]),...(a.information_gaps||[]),...(a.cautions||[])],v=>esc(v))}<small class="muted">${esc(value.model||'')} · ${esc(value.generated_at||'')} · 基于本条商机、已核实企业资料和 ${Number(value.context?.followup_count)||0} 条跟进</small>`:`<p class="muted">点击后结合该客户已核实的企业资料、售卖产品、当前阶段和历史跟进生成建议。</p>`}</section>`;
}
