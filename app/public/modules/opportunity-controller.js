import {esc} from '../ui.js';

const plans=new WeakMap();
const stages=['线索','需求','方案','商务'];
const show=value=>esc(value||'未安排');
export function mountOpportunityForm(form,S){
  if(!form)return;
  if(form.dataset.form==='opportunity-stage'){
    const original=S.opportunities.find(o=>o.id===Number(form.dataset.id));
    const sync=()=>{
      const stage=form.elements.stage.value,lost=stage==='输单',target=stages.indexOf(stage),from=stages.indexOf(original.stage);
      const reasonRequired=stage!==original.stage&&(stage==='搁置'||target>=0&&from>=0&&(target<from||target>from+1));
      if(form.elements.reason)form.elements.reason.required=reasonRequired;
      if(form.elements.lost_reason){form.elements.lost_reason.required=lost;form.elements.lost_reason.disabled=!lost;form.elements.lost_reason.closest('label').hidden=!lost;}
      const lostGroup=form.querySelector('[data-stage-lost]');if(lostGroup)lostGroup.hidden=!lost;
      const hint=form.querySelector('[data-stage-reason-hint]');if(hint)hint.textContent=reasonRequired?'跳级、回退或搁置时，请写明调整依据。':'可补充本次阶段调整依据，便于复盘。';
    };
    form.elements.stage?.addEventListener('change',sync);sync();
  }
  if(form.dataset.form==='activity'){
    const field=form.elements.update_plan;if(!field)return;
    const current=()=>S.opportunities.find(o=>o.id===Number(form.elements.opportunity_id.value));
    const setPlan=o=>plans.set(form,o?{next_action:o.next_action||'',follow_date:o.follow_date??null,updated_at:o.updated_at}:null);
    const sync=(reset=false)=>{
      const o=current(),allowed=!!o&&(S.actor.role==='admin'||S.actor.role==='sales'&&o.owner_id===S.actor.id);
      field.disabled=!allowed;if(reset||!allowed)field.checked=allowed&&form.elements.activity_date.value===S.today;
      const target=form.querySelector('[data-activity-plan-preview]'),plan=plans.get(form);
      if(target)target.innerHTML=!allowed?'<p>本次只记录沟通，当前行动计划由商机负责人维护。</p>':field.checked?`<strong>保存时同时更新当前行动计划</strong><dl><div><dt>当前安排</dt><dd>${show(plan?.next_action)} · ${show(plan?.follow_date)}</dd></div><div><dt>本次更新为</dt><dd>${show(form.elements.action.value)} · ${show(form.elements.follow_date.value)}</dd></div></dl>`:'<p>本次仅保存沟通记录，保留商机现行的下一步与跟进日期。</p>';
    };
    setPlan(current());sync(true);
    form.addEventListener('change',e=>{
      if(e.target.name==='opportunity_id'){
        const previous=S.opportunities.find(o=>o.id===Number(form.dataset.contextOpportunity)),o=current();
        if(form.elements.action.value===(previous?.next_action||''))form.elements.action.value=o?.next_action||'';
        if(form.elements.follow_date.value===(previous?.follow_date||S.today))form.elements.follow_date.value=o?.follow_date||S.today;
        form.dataset.contextOpportunity=o?.id||'';setPlan(o);sync(true);
      }else sync(e.target.name==='activity_date');
    });
    form.addEventListener('input',()=>sync());
  }
}

export function activityPlanPayload(form,values){
  const body={...values},enabled=form.elements.update_plan&&!form.elements.update_plan.disabled&&form.elements.update_plan.checked;
  body.update_plan=!!enabled;
  if(enabled){body.plan_confirmed=true;body.expected_plan=plans.get(form);}
  return body;
}

export function opportunityEditPayload(S,type,id,values){
  const original=S.opportunities.find(o=>o.id===id),body={...values};
  delete body.owner_id;delete body.customer_id;
  if(type==='edit-opportunity')delete body.stage;
  if(!original)return body;
  for(const key of Object.keys(body)){
    if(['amount','product_amount'].includes(key)){
      if(original.stage==='赢单'){delete body[key];continue;}
      if(body[key]===''&&original[key]==null||body[key]!==''&&Math.round(Number(body[key])*100)===original[key])delete body[key];
    }else if(String(body[key]??'')===String(original[key]??''))delete body[key];
  }
  if(type==='opportunity-stage'&&(body.stage||original.stage)!=='输单')delete body.lost_reason;
  if(body.reason==='')delete body.reason;
  return body;
}
