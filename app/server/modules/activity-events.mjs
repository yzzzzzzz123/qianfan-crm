import { assert, text, choice, validDate, now, today } from '../domain.mjs';
import { one } from '../database.mjs';
import {activityLockNotice} from './activity-corrections.mjs';

function currentPlan(o){
  return {next_action:o.next_action??'',follow_date:o.follow_date||null,updated_at:o.updated_at};
}

function activityPlanUpdate(actor,o,b,date,action,follow){
  if(Object.hasOwn(b,'update_plan'))assert(typeof b.update_plan==='boolean','请选择是否同步当前行动计划');
  const permitted=actor.role==='admin'||actor.role==='sales'&&Number(o.owner_id)===Number(actor.id);
  const explicit=b.update_plan===true;
  const requested=b.update_plan??(date===today()&&permitted);
  if(!requested)return {};
  assert(permitted,'仅商机负责人或管理员可以更新当前行动计划',403);
  if(explicit){
    assert(b.plan_confirmed===true,'请明确核对是否更新当前行动计划');
    const expected=b.expected_plan,latest=currentPlan(o);
    assert(expected&&typeof expected==='object'&&!Array.isArray(expected)&&
      Object.hasOwn(expected,'next_action')&&Object.hasOwn(expected,'follow_date')&&Object.hasOwn(expected,'updated_at')&&
      typeof expected.next_action==='string'&&expected.next_action===latest.next_action&&
      (expected.follow_date||null)===latest.follow_date&&expected.updated_at===latest.updated_at,
      '商机资料或当前计划已变化，请重新打开跟进表单后再核对',409);
  }
  const row={};
  if(explicit?Object.hasOwn(b,'action'):!!action)row.next_action=action;
  if(explicit?Object.hasOwn(b,'follow_date'):!!follow)row.follow_date=follow;
  return row;
}

export function recordActivity(ctx,b) {
  const {actor,db,insert,update,scoped,audit}=ctx;
  const o=scoped('opportunities',b.opportunity_id,actor,'follow');
  const type=choice(b.activity_type||'手动跟进',['手动跟进','线上会议','现场拜访','对客报价','晚会复盘'],'跟进类型');
  const source=choice(b.source||type,['手动','AI听记','晚会复盘','手动跟进','线上会议','现场拜访','对客报价'],'跟进来源');
  const summary=text(b.summary,'跟进内容',5000);
  const date=validDate(b.activity_date||today(),'跟进日期');
  assert(date<=today(),'跟进日期不能晚于今天');
  const action=text(b.action||'','下一步动作',500,false);
  const follow=validDate(b.follow_date,'下次跟进日期',true);
  const plan=activityPlanUpdate(actor,o,b,date,action,follow);
  const existing=one(db,"SELECT * FROM activities WHERE opportunity_id=? AND user_id=? AND activity_date=? AND activity_type!='系统' AND minutes_record_id IS NULL ORDER BY id LIMIT 1",o.id,actor.id,date);
  let id;
  if(existing) {
    assert((existing.summary+'\n'+summary).length<=20000,'当日跟进内容过长，请拆分记录');
    id=existing.id;
    if(!one(db,'SELECT id FROM activity_events WHERE activity_id=?',id)) insert('activity_events',{activity_id:id,opportunity_id:o.id,user_id:existing.user_id,credited_user_id:existing.user_id,source:existing.source,activity_type:existing.activity_type,activity_date:existing.activity_date,summary:existing.summary,action:existing.action||'',created_at:existing.created_at});
    // Fully voided or relocated aggregates have no live content to append.
    const live=one(db,'SELECT id FROM activity_events WHERE activity_id=? AND voided_at IS NULL',id);
    update('activities',id,{event_managed:1,summary:(live?existing.summary+'\n':'')+summary,action:action||(live?existing.action:''),source:live&&existing.source!==source?'多源':source,activity_type:live&&existing.activity_type!==type?'综合跟进':type});
  } else id=insert('activities',{opportunity_id:o.id,user_id:actor.id,source,activity_type:type,summary,action,activity_date:date,created_at:now(),event_managed:1});
  insert('activity_events',{activity_id:id,opportunity_id:o.id,user_id:actor.id,credited_user_id:o.owner_id,source,activity_type:type,activity_date:date,summary,action,created_at:now()});
  const row={updated_at:now(),...plan};
  update('opportunities',o.id,row);
  const changed=Object.keys(plan).some(key=>plan[key]!==o[key]);
  audit(actor,existing?'归并跟进':'记录跟进','opportunity',o.id,{activity_id:id,source,type,activity_date:date,plan_updated:changed,
    ...(Object.keys(plan).length?{plan:{before:currentPlan(o),after:{...currentPlan(o),...plan,updated_at:row.updated_at},explicit:b.update_plan===true}}:{})});
  return {id,plan_updated:changed,message:(existing?'已归并到同日跟进，逐次计分依据已保留':'跟进已记录')+(changed?'，当前行动计划已更新':'，当前行动计划保持原状')+activityLockNotice(db,o.owner_id,[date])};
}
