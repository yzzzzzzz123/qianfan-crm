import {all} from './database.mjs';

// Keep historical contributions when ownership changes or a file is archived.
// Recover a creation owner only from recorded evidence; do not invent one.
export function performanceInputs(db) {
  const opportunities=all(db,'SELECT o.*,c.name customer_name FROM opportunities o LEFT JOIN customers c ON c.id=o.customer_id');
  const users=new Map(all(db,'SELECT id,name,role FROM users').map(u=>[u.id,u]));
  const original=new Map(),creation=new Map();
  for(const row of all(db,"SELECT id,user_id,action,entity,entity_id,detail FROM audit WHERE (entity='opportunity' OR entity='customer') AND json_valid(detail) ORDER BY id")){
    const detail=JSON.parse(row.detail);
    if(!detail||typeof detail!=='object'||Array.isArray(detail))continue;
    if(row.entity==='opportunity'){
      if(row.action==='创建商机'){
        const owner=detail.owner_id??(users.get(row.user_id)?.role==='sales'?row.user_id:null);
        if(owner&&!creation.has(row.entity_id))creation.set(row.entity_id,{owner,created_by:row.user_id});
      }
      if(Object.hasOwn(detail.before||{},'owner_id')&&!original.has(row.entity_id))original.set(row.entity_id,detail.before.owner_id);
    }
    const transfer=detail.ownership_transfer;
    if(transfer?.scope==='linked_records')for(const id of transfer.opportunity_ids||[])if(!original.has(id))original.set(id,transfer.from_owner_id);
  }
  for(const o of opportunities){
    const initial=creation.get(o.id);
    o.created_owner_id=initial?.owner??original.get(o.id)??o.owner_id;
    o.created_by=initial?.created_by||null;
    o.creation_attribution=initial||original.has(o.id)?'recorded':'unverified';
  }
  const events=all(db,'SELECT * FROM activity_events');
  const tracked=new Set(events.map(e=>e.activity_id));
  const legacy=all(db,"SELECT * FROM activities WHERE activity_type NOT IN ('系统','系统里程碑')").filter(a=>!a.event_managed&&!tracked.has(a.id));
  return {opportunities,activities:[...events,...legacy],quotes:all(db,'SELECT * FROM quotes'),users};
}
