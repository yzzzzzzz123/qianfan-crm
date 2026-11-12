import {createHash} from 'node:crypto';
import {all,one,run} from '../../database.mjs';
import {assert,now} from '../../domain.mjs';
import {businessDate} from '../../performance-ledger.mjs';

function withdrawProjection(db,recordId,activity,reason) {
  if(!activity)return;
  // Follow-ups are derived views. Source records and any independently stored
  // events must survive clearing a summary or removing an association.
  const referenced=!!one(db,'SELECT 1 FROM activity_events WHERE activity_id=? LIMIT 1',activity.id);
  const fingerprint=createHash('sha256').update(JSON.stringify([activity.id,activity.opportunity_id,activity.activity_date,activity.summary,reason])).digest('hex');
  if(!one(db,"SELECT 1 FROM audit WHERE entity='minutes' AND entity_id=? AND action='撤下听记自动摘要' AND json_valid(detail) AND json_extract(detail,'$.projection_fingerprint')=?",recordId,fingerprint)) {
    run(db,'INSERT INTO audit(user_id,action,entity,entity_id,detail,created_at) VALUES(NULL,?,?,?,?,?)','撤下听记自动摘要','minutes',recordId,
      JSON.stringify({reason,projection_fingerprint:fingerprint,before:activity,retained_for_event_references:referenced}),now());
  }
  if(!referenced)run(db,'DELETE FROM activities WHERE id=?',activity.id);
}

/** Called inside the existing minutes save transaction. Never alters plans or scores. */
export function syncMinutesFollowup(db,recordId) {
  const record=one(db,'SELECT r.*,s.member_id FROM minutes_records r JOIN minutes_sources s ON s.id=r.source_id WHERE r.id=?',recordId);
  assert(record,'听记不存在',404);
  const old=one(db,'SELECT * FROM activities WHERE minutes_record_id=?',recordId);
  if(!record.opportunity_id) {
    withdrawProjection(db,recordId,old,'听记已取消商机关联');
    return {activity_id:null,withdrawn:true};
  }
  const summary=one(db,"SELECT * FROM minutes_artifacts WHERE record_id=? AND kind='summary'",recordId);
  if(summary?.state==='empty'||summary?.state==='ready'&&!summary.content.trim()) {
    withdrawProjection(db,recordId,old,'源平台已返回空摘要');
    return {activity_id:null,withdrawn:true};
  }
  const day=businessDate(record.start_time);
  assert(day,'听记发生时间无效');
  const ready=summary?.state==='ready'&&!!summary.content.trim();
  // Metadata belongs to the linked recording even while the source is
  // generating or temporarily unavailable. A retained body is labelled stale
  // when reporting it, never silently left on a previously linked opportunity.
  if(old) {
    run(db,'UPDATE activities SET opportunity_id=?,activity_date=?,summary=? WHERE id=?',record.opportunity_id,day,ready?summary.content.slice(0,20000):old.summary,old.id);
    return {activity_id:old.id,withdrawn:false,stale:!ready};
  }
  if(!ready)return {activity_id:null,withdrawn:false,stale:true};
  const id=Number(run(db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,action,activity_date,created_at,minutes_record_id) VALUES(?,?,'AI听记','听记摘要',?,'',?,?,?)",record.opportunity_id,record.member_id,summary.content.slice(0,20000),day,now(),recordId).lastInsertRowid);
  return {activity_id:id,withdrawn:false,stale:false};
}

/** Read-only status: also protects existing projections until their next sync. */
export function minutesActivityStatus(activity,source) {
  const state=source?.summary_state||'unavailable';
  const linked=!!source?.opportunity_id&&source.opportunity_id===activity.opportunity_id;
  const withdrawn=!linked||state==='empty';
  const current=linked&&state==='ready'&&!!source?.summary_content?.trim();
  const reasons={pending:'源摘要正在生成',failed:'源摘要本次读取未完成',unavailable:'源摘要暂未返回',unsupported_shape:'源摘要返回格式待核验'};
  const notice=current?'':!linked?'听记业务关联已变化，此摘要仅作历史保留，不作为当前业务结论。':withdrawn?'源平台已返回空摘要，此处仅保留历史版本，不作为当前业务结论。':`${reasons[state]||'源摘要当前状态待核验'}；以下为上次成功读取的版本，不作为本次新结论。`;
  return {source_kind:'minutes_summary',source_state:state,source_current:current,source_stale:!current&&!withdrawn,source_withdrawn:withdrawn,source_notice:notice,
    source_checked_at:source?.summary_checked_at||null,source_succeeded_at:source?.summary_succeeded_at||null};
}

export function minutesSummarySources(db) {
  return new Map(all(db,"SELECT r.id,r.opportunity_id,a.state summary_state,a.content summary_content,a.checked_at summary_checked_at,a.succeeded_at summary_succeeded_at FROM minutes_records r LEFT JOIN minutes_artifacts a ON a.record_id=r.id AND a.kind='summary'").map(row=>[row.id,row]));
}
