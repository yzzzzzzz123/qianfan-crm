import {all,one} from '../database.mjs';
import {assert,text,choice,validDate,today,now} from '../domain.mjs';
import {createHash} from 'node:crypto';

const types=['手动跟进','线上会议','现场拜访','对客报价','晚会复盘'];
const sources=['手动','AI听记','晚会复盘','手动跟进','线上会议','现场拜访','对客报价'];
export const activityLegacyVersion=activity=>createHash('sha256').update(JSON.stringify(
  ['id','opportunity_id','user_id','source','activity_type','activity_date','summary','action','created_at','event_managed'].map(key=>activity[key]??null)
)).digest('hex');
export function canCorrectActivityEvent(actor,event,parent) {
  return !!event && !parent?.minutes_record_id && !['系统','系统里程碑','听记摘要'].includes(event.activity_type) &&
    (actor.role==='admin'||actor.role==='sales'&&event.user_id===actor.id);
}
export function activityLockNotice(db,userId,dates) {
  const months=[...new Set(dates.filter(Boolean).map(date=>date.slice(0,7)))];
  const locked=months.filter(month=>one(db,"SELECT 1 FROM performance_reviews WHERE user_id=? AND month=? AND status='confirmed'",userId,month));
  return locked.length?`；${locked.join('、')}绩效已锁定，本次记录变更不改动该月已锁定评分` : '';
}
function rebuild(ctx,id) {
  const events=all(ctx.db,'SELECT * FROM activity_events WHERE activity_id=? AND voided_at IS NULL ORDER BY id',id);
  const summary=events.map(e=>e.summary).join('\n');
  assert(summary.length<=20000,'归并后的跟进内容过长，请缩短内容后保存');
  const values=key=>[...new Set(events.map(e=>e[key]))];
  ctx.update('activities',id,{event_managed:1,summary:summary||'该日跟进已作废或移至其他日期',
    source:values('source').length===1?events[0].source:'多源',
    activity_type:values('activity_type').length===1?events[0].activity_type:'综合跟进',
    action:[...events].reverse().find(e=>e.action)?.action||''});
}
export function correctActivityEvent(ctx,id,operation) {
  const {db,b,actor,update,insert,audit}=ctx;
  const event=one(db,'SELECT * FROM activity_events WHERE id=?',id);
  assert(event,'原始跟进不存在',404);
  const parent=one(db,'SELECT * FROM activities WHERE id=?',event.activity_id);
  assert(canCorrectActivityEvent(actor,event,parent),'仅原登记者或管理员可纠错手工跟进；听记及系统记录请在来源处维护',403);
  assert(!event.voided_at,'该原始跟进已作废',409);
  assert(typeof b.expected_updated_at==='string'&&b.expected_updated_at===(event.updated_at||event.created_at),'记录已变化，请刷新后重新核对',409);
  const reason=text(b.reason,'纠错原因',1000);
  const version=event.updated_at||event.created_at;
  const stamp=Date.parse(now())<=Date.parse(version)?new Date(Date.parse(version)+1).toISOString():now();
  let patch;
  if(operation==='void') {
    assert(b.confirmed===true,'请确认作废这一次原始跟进');
    patch={voided_at:stamp,void_reason:reason,updated_at:stamp,updated_by:actor.id};
  } else {
    const allowed=new Set(['summary','activity_type','source','activity_date','action','reason','expected_updated_at']);
    assert(Object.keys(b).every(key=>allowed.has(key)),'跟进纠错包含不可修改的字段');
    const date=validDate(b.activity_date??event.activity_date,'发生日期');assert(date<=today(),'跟进日期不能晚于今天');
    patch={summary:text(b.summary??event.summary,'跟进内容',5000),
      activity_type:choice(b.activity_type??event.activity_type,types,'跟进类型'),
      source:choice(b.source??event.source,sources,'内容来源'),activity_date:date,
      action:text(b.action??event.action??'','下一步动作',500,false),updated_at:stamp,updated_by:actor.id};
    if(date!==event.activity_date) {
      const aggregate=one(db,"SELECT * FROM activities WHERE opportunity_id=? AND user_id=? AND activity_date=? AND activity_type NOT IN ('系统','系统里程碑') AND minutes_record_id IS NULL AND id!=? ORDER BY id LIMIT 1",event.opportunity_id,event.user_id,date,event.activity_id);
      if(aggregate&&!aggregate.event_managed&&!one(db,'SELECT id FROM activity_events WHERE activity_id=?',aggregate.id)) {
        insert('activity_events',{activity_id:aggregate.id,opportunity_id:aggregate.opportunity_id,user_id:aggregate.user_id,credited_user_id:aggregate.user_id,source:aggregate.source,activity_type:aggregate.activity_type,activity_date:aggregate.activity_date,summary:aggregate.summary,action:aggregate.action||'',created_at:aggregate.created_at});
      }
      patch.activity_id=aggregate?.id??insert('activities',{opportunity_id:event.opportunity_id,user_id:event.user_id,source:patch.source,activity_type:patch.activity_type,summary:patch.summary,action:patch.action,activity_date:date,created_at:stamp,event_managed:1});
    }
  }
  update('activity_events',id,patch);
  rebuild(ctx,event.activity_id);
  if(patch.activity_id&&patch.activity_id!==event.activity_id)rebuild(ctx,patch.activity_id);
  const after=one(db,'SELECT * FROM activity_events WHERE id=?',id);
  audit(actor,operation==='void'?'作废原始跟进':'纠错原始跟进','activity_event',id,{reason,before:event,after,current_plan_updated:false});
  return {id,message:(operation==='void'?'已作废本次跟进，未锁定绩效已重新计算':'原始跟进已更新，未锁定绩效已重新计算')+'，商机当前计划保持原状'+activityLockNotice(db,event.credited_user_id,[event.activity_date,after.activity_date])};
}

// Legacy imports are materialized only when a user saves a correction. Their
// existing recorder-based scoring attribution is retained, never guessed anew.
export function correctLegacyActivity(ctx,id,operation) {
  const {db,b,actor,insert,update}=ctx,parent=one(db,'SELECT * FROM activities WHERE id=?',id);
  assert(parent,'历史跟进不存在',404);
  assert(canCorrectActivityEvent(actor,parent,parent),'仅原登记者或管理员可更正手工历史跟进',403);
  assert(!parent.event_managed&&!one(db,'SELECT id FROM activity_events WHERE activity_id=?',id),'此记录已有逐次依据，请刷新后更正原始记录',409);
  assert(b.expected_updated_at===activityLegacyVersion(parent),'历史记录已变化，请刷新后重新核对',409);
  text(b.reason,'纠错原因',1000);
  const eventId=insert('activity_events',{activity_id:id,opportunity_id:parent.opportunity_id,user_id:parent.user_id,credited_user_id:parent.user_id,
    source:parent.source,activity_type:parent.activity_type,activity_date:parent.activity_date,summary:parent.summary,action:parent.action||'',created_at:parent.created_at});
  update('activities',id,{event_managed:1});
  return correctActivityEvent({...ctx,b:{...b,expected_updated_at:parent.created_at}},eventId,operation);
}
