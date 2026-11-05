const dayMs=86400000;
export const minutesUpdateIntervalMs=300000;
export const minutesSchedulerIntervalMs=60000;

// Reconcile the current week like SparNow; Monday also covers the previous
// week. Keep the incremental watermark overlap if a service outage is longer.
export function minutesIncrementalFrom(source,at,{automatic=false}={}){
  const connected=Date.parse(source.collect_from);
  let from=source.synced_until?Math.max(connected,Date.parse(source.synced_until)-dayMs):connected;
  if(automatic){
    const local=new Date(at+8*3600000),weekday=local.getUTCDay();
    const midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-8*3600000;
    const monday=midnight-((weekday+6)%7)*dayMs;
    from=Math.max(connected,Math.min(from,weekday===1?monday-7*dayMs:monday));
  }
  return new Date(from).toISOString();
}

// The database run history is the retry clock; restarting the process does not
// reset a failing account's backoff or require an open browser session.
export function minutesSourceSchedule(runs,{automatic,configured,connected,at=Date.now()}={}){
  const latest=runs[0],failures=runs.findIndex(r=>r.status!=='failed');
  const failedCount=failures<0?runs.length:failures;
  const delay=latest?.status==='failed'?Math.min(3600000,minutesUpdateIntervalMs*2**Math.min(4,Math.max(0,failedCount-1))):minutesUpdateIntervalMs;
  const next=latest?Date.parse(latest.finished_at||latest.created_at)+delay:at;
  const state=!connected?'stopped':!configured?'unconfigured':!automatic?'local':latest?.status==='running'?'running':latest?.status==='failed'?'retrying':'scheduled';
  return {state,interval_seconds:minutesUpdateIntervalMs/1000,next_update_at:['scheduled','retrying'].includes(state)?new Date(next).toISOString():null,last_status:latest?.status||null,last_error:latest?.status==='failed'?latest.error_message||'听记更新未完成，将自动重试':'',due:automatic&&configured&&connected&&latest?.status!=='running'&&at>=next};
}
