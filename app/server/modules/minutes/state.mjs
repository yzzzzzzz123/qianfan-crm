// Core business content and optional channel capabilities have separate states.
export const coreKinds=['summary','transcript'];
const retryable=new Set(['pending','failed','unsupported_shape']);
export function minutesContentState(artifacts={}) {
  const values=coreKinds.map(kind=>artifacts[kind]?.state);
  if(values.some(state=>state==='failed'||state==='unsupported_shape'))return {state:'failed',label:'正文读取失败'};
  if(values.some(state=>state==='unavailable'))return {state:'unavailable',label:'源通道未提供完整正文'};
  if(values.every(state=>state==='ready'||state==='empty'))return {state:'ready',label:values.every(state=>state==='empty')?'暂无正文':'正文完整'};
  return {state:'pending',label:'正文生成或读取中'};
}
export const retryableCore=artifacts=>coreKinds.some(kind=>!artifacts?.[kind]||retryable.has(artifacts[kind].state));
export const coreStateSql=(summary='ms',transcript='mt')=>`CASE
  WHEN ${summary}.state IN ('failed','unsupported_shape') OR ${transcript}.state IN ('failed','unsupported_shape') THEN 'failed'
  WHEN ${summary}.state='unavailable' OR ${transcript}.state='unavailable' THEN 'unavailable'
  WHEN ${summary}.state IN ('ready','empty') AND ${transcript}.state IN ('ready','empty') THEN 'ready'
  ELSE 'pending' END`;
export const minutesPageSize=value=>[10,30,50].includes(Number(value))?Number(value):10;
export const minutesPageNumber=value=>Math.max(1,Math.min(100000,Math.floor(Number(value)||1)));
