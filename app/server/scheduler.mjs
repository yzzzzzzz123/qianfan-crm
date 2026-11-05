import { all, one, run, transaction } from './database.mjs';
import { today, dateAdd, now } from './domain.mjs';
export function refreshDailyReport(db,at=new Date()) {
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(at));
  const due=hour>=20?day:dateAdd(-1,day);
  if(one(db,'SELECT day FROM daily_reports WHERE day=?',due))return false;
  const snapshot={scheduled_for:due+'T20:00:00+08:00',captured_at:at.toISOString(),missedRunPolicy:'run_latest',summary:all(db,"SELECT u.id user_id,u.name,(SELECT COUNT(*) FROM opportunities o WHERE o.owner_id=u.id AND o.archived_at IS NULL AND o.stage NOT IN('赢单','输单','搁置')) opportunities,(SELECT COALESCE(SUM(o.amount),0) FROM opportunities o WHERE o.owner_id=u.id AND o.archived_at IS NULL AND o.stage NOT IN('赢单','输单','搁置')) pipeline,(SELECT COALESCE(SUM(c.amount),0) FROM contracts c WHERE c.owner_id=u.id AND c.retired_at IS NULL AND c.lifecycle!='草稿') signed,(SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE c.owner_id=u.id AND c.retired_at IS NULL AND c.lifecycle!='草稿' AND p.status='已到账') collected FROM users u WHERE u.active=1 AND u.role IN('admin','sales') AND u.business_member=1 AND u.developer_admin=0")};
  transaction(db,()=>run(db,'INSERT OR IGNORE INTO daily_reports VALUES(?,?,?)',due,JSON.stringify(snapshot),now()));return true;
}
export function startDailyRefresh(db,logger=console,{deployment='local'}={}) {
  // 已停用自动日报快照。保留历史表及显式生成函数，不再启动或补跑定时器。
  return ()=>{};
}
