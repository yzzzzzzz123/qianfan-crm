import {assert} from '../../domain.mjs';
const dayMs=86400000;
export function minutesDateRange(from,to,{required=false}={}){
  if((from===undefined||from==='')&&(to===undefined||to===''))return required?{from:'1970-01-01T00:00:00.000Z',to:new Date().toISOString(),full:true}:null;
  const parse=value=>{assert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),'请选择有效的听记日期');const stamp=Date.parse(value+'T00:00:00+08:00');assert(Number.isFinite(stamp)&&new Date(stamp+8*3600000).toISOString().slice(0,10)===value,'请选择有效的听记日期');return stamp;};
  const start=parse(from),last=parse(to),today=Math.floor((Date.now()+8*3600000)/dayMs)*dayMs-8*3600000;
  assert(last>=start,'开始日期不能晚于结束日期');assert(last<=today,'听记日期不能晚于今天');
  return {from:new Date(start).toISOString(),to:new Date(last+dayMs).toISOString()};
}
