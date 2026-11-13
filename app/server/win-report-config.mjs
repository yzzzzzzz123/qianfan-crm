import {assert,text} from './domain.mjs';
import {one,run} from './database.mjs';

export const winReportGroups=[{key:'wanjin',name:'四两拨万金（千帆）'}];
export const winReportTestGroup={key:'test',name:'赢单战报测试群'};
export function readWinReportConfig(db,env={}){
  const stored=JSON.parse(one(db,"SELECT value FROM settings WHERE key='win_report'")?.value||'{}');
  return {
    enabled:stored.enabled===true,
    robot_code:stored.robot_code||env.DINGTALK_WIN_REPORT_ROBOT_CODE||env.DINGTALK_WIN_REPORT_CLIENT_ID||env.DINGTALK_CLIENT_ID||'',
    template_id:stored.template_id||env.DINGTALK_WIN_REPORT_TEMPLATE_ID||'',
    test_conversation_id:stored.test_conversation_id||env.DINGTALK_WIN_REPORT_TEST_GROUP||'',
    groups:winReportGroups.map(g=>({...g,conversation_id:stored.groups?.find(v=>v.key===g.key)?.conversation_id||env.DINGTALK_WIN_REPORT_WANJIN_GROUP||''})),
  };
}
const groupId=value=>{const id=text(value,'群会话 ID',200,false);assert(!id||/^cid[^\s<>]{1,190}$/.test(id),'请填写钉钉返回的 openConversationId');return id;};
export function saveWinReportConfig(db,b,{env={},canEnable=false}={}){
  assert(Object.keys(b).every(k=>['enabled','robot_code','template_id','test_conversation_id','groups','confirmed'].includes(k)),'战报设置包含未知字段');
  const previous=readWinReportConfig(db,env),next={...previous};
  if(b.enabled!==undefined){assert(typeof b.enabled==='boolean','自动推送开关无效');next.enabled=b.enabled;}
  for(const [key,label] of [['robot_code','机器人编码'],['template_id','卡片模板 ID']])if(b[key]!==undefined)next[key]=text(b[key],label,200,false);
  if(b.test_conversation_id!==undefined)next.test_conversation_id=groupId(b.test_conversation_id);
  if(b.groups!==undefined){
    assert(Array.isArray(b.groups)&&b.groups.length===winReportGroups.length,'请配置四两拨万金（千帆）正式群');
    assert(new Set(b.groups.map(g=>g?.key)).size===winReportGroups.length&&b.groups.every(g=>g&&Object.keys(g).every(k=>['key','conversation_id'].includes(k))&&winReportGroups.some(v=>v.key===g.key)),'正式群配置无效');
    next.groups=winReportGroups.map(g=>({...g,conversation_id:groupId(b.groups.find(v=>v.key===g.key).conversation_id)}));
  }
  const configuredIds=[next.test_conversation_id,...next.groups.map(g=>g.conversation_id)].filter(Boolean);
  assert(new Set(configuredIds).size===configuredIds.length,'测试群和正式群须为不同群');
  const changed=['robot_code','template_id','test_conversation_id','groups'].some(k=>JSON.stringify(next[k])!==JSON.stringify(previous[k]));
  if(changed)next.enabled=false;
  if(b.enabled===true){
    assert(canEnable,'正式自动推送只能在服务器启用',409);
    assert(!changed,'配置变更后请先重新验证测试卡片，再开启自动推送',409);
    assert(next.robot_code&&next.template_id&&next.test_conversation_id&&next.groups.every(g=>g.conversation_id),'请先配置机器人、卡片模板、测试群和正式群');
    for(const g of [{...winReportTestGroup,conversation_id:next.test_conversation_id},...next.groups]){
      assert(one(db,"SELECT 1 FROM win_report_deliveries d JOIN win_report_events e ON e.id=d.event_id WHERE e.kind='test' AND d.status='sent' AND d.group_key=? AND d.conversation_id=? AND d.robot_code=? AND d.template_id=?",g.key,g.conversation_id,next.robot_code,next.template_id),`${g.name}尚未成功收到测试卡片`,409);
    }
    assert(b.confirmed===true,'请确认手机、电脑显示正常，负责人实际收到 @ 提醒');
    next.enabled=true;
  }
  run(db,"INSERT INTO settings(key,value) VALUES('win_report',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(next));
  return next;
}
