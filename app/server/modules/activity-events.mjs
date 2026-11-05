import { assert, text, choice, validDate, now, today } from '../domain.mjs';
import { one } from '../database.mjs';

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
  const existing=one(db,"SELECT * FROM activities WHERE opportunity_id=? AND user_id=? AND activity_date=? AND activity_type!='系统' AND minutes_record_id IS NULL ORDER BY id LIMIT 1",o.id,actor.id,date);
  let id;
  if(existing) {
    assert((existing.summary+'\n'+summary).length<=20000,'当日跟进内容过长，请拆分记录');
    id=existing.id;
    if(!one(db,'SELECT id FROM activity_events WHERE activity_id=?',id)) insert('activity_events',{activity_id:id,opportunity_id:o.id,user_id:existing.user_id,credited_user_id:o.owner_id,source:existing.source,activity_type:existing.activity_type,activity_date:existing.activity_date,summary:existing.summary,created_at:existing.created_at});
    update('activities',id,{summary:existing.summary+'\n'+summary,action:action||existing.action,source:existing.source===source?source:'多源',activity_type:existing.activity_type===type?type:'综合跟进'});
  } else id=insert('activities',{opportunity_id:o.id,user_id:actor.id,source,activity_type:type,summary,action,activity_date:date,created_at:now()});
  insert('activity_events',{activity_id:id,opportunity_id:o.id,user_id:actor.id,credited_user_id:o.owner_id,source,activity_type:type,activity_date:date,summary,created_at:now()});
  const row={updated_at:now()};if(action)row.next_action=action;if(follow)row.follow_date=follow;
  update('opportunities',o.id,row);
  audit(actor,existing?'归并跟进':'记录跟进','opportunity',o.id,{activity_id:id,source,type});
  return {id,message:existing?'已归并到同日跟进，逐次计分依据已保留':'跟进已记录'};
}
