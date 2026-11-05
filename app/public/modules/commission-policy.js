import {esc,plainMoney} from '../ui.js';
export const percent=value=>value==null?'待核实':`${(value*100).toLocaleString('zh-CN',{maximumFractionDigits:2})}%`;
export function salesPolicyFromForm(current,fields){
  const policy=structuredClone(current);
  if(fields.effective_month!==undefined)policy.effective_month=fields.effective_month;
  policy.service_aggregation=fields.service_aggregation==='pending_contract'?'contract':fields.service_aggregation;
  policy.service_scope_confirmed=fields.service_aggregation!=='pending_contract';
  for(const type of ['product','service'])policy[type].forEach((band,i)=>{
    if(i>0){const value=fields[`min:${type}:${i}`];if(!/^\d+(?:\.\d{1,2})?$/.test(value||''))throw new Error('请填写有效的档位金额，最多两位小数');band.min=Math.round(Number(value)*100);}
    for(const grade of ['D','C','B','A']){const value=fields[`rate:${type}:${i}:${grade}`];if(value===undefined)throw new Error('提成比例字段不完整');band.rates[grade]=value===''?null:Number(value)/100;}
  });
  return policy;
}
export function policyMatrix(policy,type,editor=false) {
  if(!policy)return '';
  const bands=policy[type];
  const field=(name,label,value,extra)=>`<input name="${name}" type="number" value="${esc(value)}" aria-label="${esc(label)}" ${extra}>`;
  return `<div class="table-scroll"><table class="data-table policy-matrix ${editor?'policy-editor':''}"><caption>${type==='product'?'产品回款提成':'项目／服务提成'}${editor?'（比例单位：%）':''}</caption><thead><tr><th>${editor?'起档金额（元）':'金额档位（元）'}</th>${['D','C','B','A'].map(g=>`<th>${g} 级</th>`).join('')}</tr></thead><tbody>${bands.map((band,i)=>`<tr><th>${editor?(i===0?'0（起始档）':field(`min:${type}:${i}`,`第 ${i+1} 档起点（元）`,band.min/100,'required min="0.01" max="10000000000" step="0.01"')):i===bands.length-1?`≥ ${plainMoney(band.min)}`:i===0?`< ${plainMoney(bands[i+1].min)}`:`${plainMoney(band.min)} ≤ 金额 < ${plainMoney(bands[i+1].min)}`}</th>${['D','C','B','A'].map(g=>`<td>${editor?field(`rate:${type}:${i}:${g}`,`${g}级 第${i+1}档（%）`,band.rates[g]==null?'':Math.round(band.rates[g]*10000)/100,'min="0" max="100" step="0.01" placeholder="待核实"'):esc(percent(band.rates[g]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
