import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,customer,opp,contract,archiveContract} from './helpers/fixture.mjs';
import {all,one,run,transaction,openDatabase} from '../server/database.mjs';
import {createWinReports} from '../server/win-reports.mjs';
import {readWinReportConfig,saveWinReportConfig} from '../server/win-report-config.mjs';
import {createWinReportSender} from '../server/dingtalk-win-report.mjs';
import {winReportPanel,winReportRetryForm} from '../public/modules/win-reports.js';
import {migrateWinReports} from '../server/win-report-schema.mjs';
import fs from 'node:fs';

const settings={enabled:true,robot_code:'test-robot',template_id:'test.schema',test_conversation_id:'cid-test',groups:[{key:'wanjin',name:'四两拨万金（千帆）',conversation_id:'cid-wanjin'}]};
const configure=(db,patch={})=>run(db,"INSERT INTO settings(key,value) VALUES('win_report',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify({...settings,...patch}));
async function setup(t,{send=async()=>{},enabled=true}={}){
  const sent=[];
  const sender={configured:true,simulated:true,async send(d,s){sent.push({delivery:{...d},snapshot:structuredClone(s)});return send(d,s);}};
  const f=await fixture(t,{winReportOptions:{sender}});
  configure(f.db,{enabled});
  run(f.db,"UPDATE users SET ding_user_id='verified-owner' WHERE id=1");
  const admin=await f.login(1),sales=await f.login(2);
  async function win(extra={}){
    const c=await f.request('/customers',{actor:admin,method:'POST',body:customer({name:'战报客户'+Math.random()})});assert.equal(c.status,200,JSON.stringify(c.body));
    const o=await f.request('/opportunities',{actor:admin,method:'POST',body:opp(c.body.id,{name:'成单产品<测试>'})});assert.equal(o.status,200);
    const result=await f.request('/contracts',{actor:admin,method:'POST',body:contract(o.body.id,extra)});assert.equal(result.status,200,JSON.stringify(result.body));
    await f.service.winReports.kick();
    return {opportunityId:o.body.id,contractId:result.body.id};
  }
  return {...f,admin,sales,sent,win};
}

test('首次赢单仅向四两拨万金发送一次，新增合同及补签章不重复，快照固定',async t=>{
  const f=await setup(t),w=await f.win();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].delivery.group_key,'wanjin');assert.equal(f.sent[0].snapshot.amount,10000000);
  await archiveContract(f,f.admin,w.contractId);
  const additional=await f.request('/contracts',{actor:f.admin,method:'POST',body:contract(w.opportunityId,{additional:true,items:[{name:'追加',kind:'标品',amount:100}]})});assert.equal(additional.status,200);
  await f.service.winReports.kick();assert.equal(f.sent.length,1);
  const report=f.service.winReports.describe(w.opportunityId);assert.equal(report.snapshot.amount,10000000);assert.equal(report.groups.length,1);assert.equal(report.groups[0].status,'sent');
  assert.equal(one(f.db,'SELECT count(*) n FROM win_report_events').n,1);
});

test('赢单事务失败时不遗留战报事件或发送任务',async t=>{
  const f=await setup(t);const c=await f.request('/customers',{actor:f.admin,method:'POST',body:customer()});
  const o=await f.request('/opportunities',{actor:f.admin,method:'POST',body:opp(c.body.id)});
  f.db.exec("CREATE TRIGGER reject_milestone BEFORE INSERT ON activities WHEN NEW.source='系统里程碑' BEGIN SELECT RAISE(ABORT,'isolated rollback'); END");
  const r=await f.request('/contracts',{actor:f.admin,method:'POST',body:contract(o.body.id)});assert.equal(r.status,500);
  assert.equal(one(f.db,'SELECT count(*) n FROM win_report_events').n,0);assert.equal(one(f.db,'SELECT count(*) n FROM win_report_deliveries').n,0);assert.equal(f.sent.length,0);
});

test('开关关闭期间的赢单不在开启后补历史，重新进入赢单也不重发',async t=>{
  const f=await setup(t,{enabled:false}),w=await f.win();assert.equal(f.sent.length,0);assert.equal(f.service.winReports.describe(w.opportunityId).groups[0].status,'skipped');
  configure(f.db);run(f.db,"UPDATE opportunities SET stage='商务' WHERE id=?",w.opportunityId);
  const r=await f.request('/contracts',{actor:f.admin,method:'POST',body:contract(w.opportunityId,{additional:true})});assert.equal(r.status,200);await f.service.winReports.kick();assert.equal(f.sent.length,0);
});

test('失败只补发指定记录，成功记录不能重发，卡片标识保持不变',async t=>{
  let failing=true;
  const f=await setup(t,{send:async()=>{if(failing){const e=new Error('secret should never be persisted');Object.assign(e,{uncertain:false,code:'FORBIDDEN'});throw e;}}});
  const first=await f.win();failing=false;const second=await f.win();
  const d=f.service.winReports.describe(first.opportunityId).groups[0];assert.equal(d.status,'failed');
  const r=await f.request(`/opportunities/${first.opportunityId}/win-report/${d.id}/retry`,{actor:f.admin,method:'POST',body:{}});assert.equal(r.status,200);await f.service.winReports.kick();
  assert.equal(f.sent.length,3);assert.equal(f.sent[0].delivery.out_track_id,f.sent[2].delivery.out_track_id);
  assert.equal(f.service.winReports.describe(second.opportunityId).groups[0].attempts,1);
  assert.equal((await f.request(`/opportunities/${first.opportunityId}/win-report/${d.id}/retry`,{actor:f.admin,method:'POST',body:{}})).status,409);
  assert.doesNotMatch(JSON.stringify(all(f.db,'SELECT * FROM win_report_deliveries')),/secret should/);
});

test('超时状态不自动重发，核对未送达后才允许人工补发',async t=>{
  let failing=true;const f=await setup(t,{send:async()=>{if(failing)throw new Error('timeout');}}),w=await f.win();
  const d=f.service.winReports.describe(w.opportunityId).groups[0];assert.equal(d.status,'uncertain');await f.service.winReports.kick();assert.equal(f.sent.length,1);
  assert.equal((await f.request(`/opportunities/${w.opportunityId}/win-report/${d.id}/retry`,{actor:f.admin,method:'POST',body:{}})).status,409);
  failing=false;assert.equal((await f.request(`/opportunities/${w.opportunityId}/win-report/${d.id}/retry`,{actor:f.admin,method:'POST',body:{confirmed_not_delivered:true}})).status,200);await f.service.winReports.kick();assert.equal(f.sent.length,2);
});

test('服务恢复时发送中的旧租约标为待核对，不再次投放',async t=>{
  const f=await setup(t),w=await f.win();run(f.db,"UPDATE win_report_deliveries SET status='sending',lease_until='2000-01-01T00:00:00.000Z' WHERE event_id=?",f.service.winReports.describe(w.opportunityId).id);
  await f.service.winReports.kick();assert.equal(f.sent.length,1);assert.equal(f.service.winReports.describe(w.opportunityId).groups[0].status,'uncertain');
});

test('普通销售看不到群投递状态，也不能配置、测试或补发',async t=>{
  const f=await setup(t),w=await f.win(),d=f.service.winReports.describe(w.opportunityId).groups[0];
  const state=(await f.request('/state',{actor:f.sales})).body;assert.equal(state.win_reports,undefined);assert.ok(state.opportunities.every(o=>o.win_report===undefined));
  for(const [path,body,method] of [['/win-reports/config',{enabled:false},'PATCH'],['/win-reports/test',{group_key:'test'},'POST'],[`/opportunities/${w.opportunityId}/win-report/${d.id}/retry`,{},'POST']])assert.equal((await f.request(path,{actor:f.sales,method,body})).status,403);
});

test('本地环境即使开启配置也不能通过真实发送器外发',async t=>{
  const f=await setup(t);let calls=0;
  const local=createWinReports({db:f.db,deployment:'local',env:{NODE_ENV:'production',CRM_RUNTIME_ENVIRONMENT:'server',PUBLIC_ORIGIN:'https://example.test'},sender:{configured:true,send:async()=>{calls++;}}});
  assert.equal(local.canExecute(),false);assert.throws(()=>local.testCard({id:1},{group_key:'test'}),/服务器/);assert.throws(()=>local.saveConfig({enabled:true,confirmed:true}),/服务器/);await local.kick();assert.equal(calls,0);await local.shutdown();
});

test('先测试群，再验证正式群，全部成功及人工确认后才能启用',async t=>{
  const f=await setup(t,{enabled:false});
  assert.throws(()=>f.service.winReports.saveConfig({enabled:true,confirmed:true}),/测试卡片/);
  assert.throws(()=>f.service.winReports.testCard({id:1},{group_key:'wanjin'}),/先跑通测试群/);
  transaction(f.db,()=>f.service.winReports.testCard({id:1},{group_key:'test'}));await f.service.winReports.kick();
  transaction(f.db,()=>f.service.winReports.testCard({id:1},{group_key:'wanjin'}));await f.service.winReports.kick();
  assert.throws(()=>f.service.winReports.saveConfig({enabled:true}),/实际收到/);
  f.service.winReports.saveConfig({enabled:true,confirmed:true});assert.equal(f.service.winReports.summary().enabled,true);
  assert.throws(()=>f.service.winReports.saveConfig({groups:[{key:'qianfan',conversation_id:'cid-excluded'}]}),/正式群配置无效/);
  assert.equal(readWinReportConfig(f.db).groups[0].name,'四两拨万金（千帆）');
});

test('迁移幂等且不生成历史战报，配置里不保留被取消的群',()=>{
  const db=openDatabase(':memory:');try{assert.equal(one(db,'SELECT MAX(version) n FROM schema_version').n,37);assert.equal(one(db,'SELECT count(*) n FROM win_report_events').n,0);configure(db,{groups:[{key:'qianfan',conversation_id:'cid-excluded'},...settings.groups]});assert.equal(readWinReportConfig(db).groups.length,1);assert.equal(readWinReportConfig(db).groups[0].key,'wanjin');assert.throws(()=>saveWinReportConfig(db,{groups:[{key:'qianfan',conversation_id:'cid-excluded'}]}),/正式群配置无效/);}finally{db.close();}
});

test('非业务管理员可用本人验证测试卡片，不改变成员归属或代选其他非业务账号',async t=>{
  const f=await setup(t,{enabled:false});
  run(f.db,'UPDATE users SET developer_admin=1,business_member=0,performance_enabled=0 WHERE id=1');
  const before=one(f.db,'SELECT * FROM users WHERE id=1');
  const businessCounts=one(f.db,'SELECT (SELECT count(*) FROM opportunities) opportunities,(SELECT count(*) FROM contracts) contracts');
  transaction(f.db,()=>f.service.winReports.testCard({id:1},{group_key:'test'}));await f.service.winReports.kick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].snapshot.owner_id,1);assert.equal(f.sent[0].snapshot.test,true);
  assert.deepEqual(one(f.db,'SELECT * FROM users WHERE id=1'),before);
  assert.deepEqual(one(f.db,'SELECT (SELECT count(*) FROM opportunities) opportunities,(SELECT count(*) FROM contracts) contracts'),businessCounts);
  assert.throws(()=>f.service.winReports.testCard({id:2},{group_key:'test',owner_id:1}),/本人或/);
});

test('卡片适配器传真实 @ 参数及整数分金额，不输出凭据',async()=>{
  const requests=[];const sender=createWinReportSender({env:{DINGTALK_CLIENT_ID:'app',DINGTALK_CLIENT_SECRET:'private-secret'},fetcher:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(url.endsWith('accessToken')?{accessToken:'private-token',expireIn:7200}:{success:true,result:{outTrackId:'track-1',deliverResults:[{spaceType:'IM_GROUP',spaceId:'cid-group',success:true}]}}),{status:200});}});
  await sender.send({template_id:'template.schema',out_track_id:'track-1',conversation_id:'cid-group',robot_code:'robot'},{owner_name:'王宏',ding_user_id:'verified-owner',customer_name:'测试客户',sales_content:'产品',contract_no:'HT1',amount:12345,sign_date:'2026-11-13',won_at:'now'});
  const payload=JSON.parse(requests[1].options.body);assert.equal(payload.cardData.cardParamMap.amount,'123.45');assert.deepEqual(payload.imGroupOpenDeliverModel.atUserIds,{'verified-owner':'王宏'});assert.equal(payload.openSpaceId,'dtv1.card//IM_GROUP.cid-group');assert.doesNotMatch(requests[1].options.body,/private-secret|private-token/);
});

test('HTTP成功但目标群投放失败不能显示发送成功，独立凭证不得混用',async()=>{
  const sender=createWinReportSender({env:{DINGTALK_CLIENT_ID:'app',DINGTALK_CLIENT_SECRET:'secret'},fetcher:async url=>new Response(JSON.stringify(url.endsWith('accessToken')?{accessToken:'token'}:{success:true,result:{outTrackId:'track',deliverResults:[{spaceType:'IM_GROUP',spaceId:'cid-group',success:false,errorMsg:'private upstream text'}]}}),{status:200})});
  await assert.rejects(()=>sender.send({template_id:'test.schema',out_track_id:'track',conversation_id:'cid-group',robot_code:'robot'},{ding_user_id:'owner',owner_name:'销售',amount:100}),e=>e.code==='GROUP_DELIVERY_REJECTED'&&e.uncertain===false&&!e.message.includes('private upstream'));
  assert.equal(createWinReportSender({env:{DINGTALK_CLIENT_ID:'base',DINGTALK_CLIENT_SECRET:'base-secret',DINGTALK_WIN_REPORT_CLIENT_ID:'separate'}}).configured,false);
});

test('已创建的失败卡片补发走投放接口，沿用卡片标识',async()=>{
  const calls=[];
  const sender=createWinReportSender({env:{DINGTALK_CLIENT_ID:'app',DINGTALK_CLIENT_SECRET:'secret'},fetcher:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(url.endsWith('accessToken')?{accessToken:'token'}:{success:true,result:[{spaceType:'IM_GROUP',spaceId:'cid-group',success:true}]}),{status:200});}});
  await sender.send({card_created:1,out_track_id:'existing-track',conversation_id:'cid-group',robot_code:'robot',template_id:'template'},{ding_user_id:'owner',owner_name:'负责人',amount:100});
  assert.ok(calls[1].url.endsWith('/instances/deliver'));assert.equal(calls[1].body.outTrackId,'existing-track');assert.equal(calls[1].body.cardTemplateId,undefined);
});

test('战报迁移失败回滚新表，可在原库重新执行且不改业务行',()=>{
  const db=openDatabase(':memory:');try{
    db.exec('DROP TABLE win_report_deliveries; DROP TABLE win_report_events; DELETE FROM schema_version WHERE version=37;');
    const before=all(db,'SELECT * FROM users');
    db.exec("CREATE TRIGGER fail_win_report BEFORE INSERT ON schema_version WHEN NEW.version=37 BEGIN SELECT RAISE(ABORT,'isolated migration failure'); END");
    assert.throws(()=>migrateWinReports(db),/isolated migration failure/);assert.equal(one(db,"SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'win_report_%'").n,0);assert.deepEqual(all(db,'SELECT * FROM users'),before);
    db.exec('DROP TRIGGER fail_win_report');migrateWinReports(db);migrateWinReports(db);assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,37);assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
  }finally{db.close();}
});

test('交付模板字段与发送适配器一致，模板不包含交互回调或真实业务数据',()=>{
  const template=JSON.parse(fs.readFileSync(new URL('../integrations/dingtalk/win-report-template.json',import.meta.url),'utf8'));
  const editor=JSON.parse(template.editorData),vars=editor.variableList.map(v=>v.name);
  for(const key of ['title','amount_text','owner_text','customer_text','sales_text','contract_text','date_text'])assert.ok(vars.includes(key),key);
  // Match the actual message-card export, including its nested serialized editor document.
  assert.equal(template.type,'im');assert.equal(template.mode,'card');assert.equal(editor.schemaVersion,'3.0.0');
  const root=editor.schema.componentsTree[0];assert.equal(root.componentName,'Card');
  assert.match(editor.mockData.cardData.amount_text,/100\.00\n签约金额/);
  const components=[root,...root.children],ids=components.map(n=>n.id);
  assert.equal(new Set(ids).size,ids.length);
  for(const n of components){assert.ok(editor.schema.componentsMap.some(c=>c.componentName===n.componentName));assert.ok(template.widgetInfo.includes(`userId="${n.id}"`));}
  for(const variable of editor.variableList){
    assert.ok(template.widgetInfo.includes(`data.cardData.${variable.name}`),`${variable.name} must also render in native XML`);
    if(variable.type==='markdown'){
      const bound=root.children.find(n=>n.props?.content?.variable===variable.name);assert.equal(bound?.componentName,'Markdown');
      assert.equal(editor.mockData.richTextData.cardData[variable.name].version,'1.1');assert.ok(editor.mockData.richTextData.cardData[variable.name].items.length);
    }
  }
  assert.equal(editor.extension.extendType,'NORMAL');assert.deepEqual(editor.extension.fileTypeList,[{fileName:'event_chain',fileSource:'{}',fileType:'json'}]);assert.doesNotMatch(template.widgetInfo,/DDEventView|dtCallAPI|dtOpenLink/);
});

test('管理者详情显示单群真实状态，销售不显示，补发文案与超时核对一致',()=>{
  const group={id:7,group_name:'四两拨万金（千帆）',status:'uncertain',status_label:'待核对投放结果',error_message:'请核对',can_retry:true,needs_verification:true};
  const o={id:9,stage:'赢单',win_report:{snapshot:{owner_name:'王宏<script>',amount:10000},groups:[group]}};const S={actor:{role:'admin'},win_reports:{enabled:true},opportunities:[o]};
  const html=winReportPanel(S,o);assert.match(html,/四两拨万金/);assert.doesNotMatch(html,/千帆逐苍穹|<script>/);assert.match(html,/核对后补发/);assert.match(winReportRetryForm(S,9,7),/confirmed_not_delivered/);assert.equal(winReportPanel({...S,actor:{role:'sales'}},o),'');
});
