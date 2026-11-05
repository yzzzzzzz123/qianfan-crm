export function recognizeMinutes({tags=[],verified=false,recording=false,member,config={}}){
  const none=reason=>({type:'none',reason,recording_evidence:recording?'present':'unknown'});
  if(!member||member.role!=='sales'||member.active!==1||member.business_member!==1||member.developer_admin===1)return none('当前成员不参与销售活动认定');
  if(!verified)return none('源标签尚未核验');
  if(!recording)return none('录音存在性尚未确认');
  const visit=Array.isArray(config.visitTagIds)&&tags.some(t=>config.visitTagIds.includes(t)),demo=Array.isArray(config.demoTagIds)&&tags.some(t=>config.demoTagIds.includes(t));
  if(visit===demo)return none(visit?'源标签存在分类冲突':'未配置匹配的活动标签');
  return {type:visit?'visit':'demo',reason:'已核验源标签及录音存在证据',recording_evidence:'present'};
}
