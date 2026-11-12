import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {createMinutesClient} from '../server/modules/minutes/client.mjs';
import {parseSpeakerSummary,isEmptySpeakerQuery,speakerPending} from '../server/modules/minutes/speaker.mjs';
import {minuteArtifact} from '../public/modules/minutes-artifacts.js';
import {qualityInput,analyzeQuality,createQualityComplete} from '../server/modules/minutes/quality.mjs';

test('原生发言人总结只接受明确完成的正文，创建回执和未知格式不当作结果',()=>{
 const complete={status:'completed',innerStatus:'Finished',success:true,taskId:'native-task',errorMsg:'',content:' 发言人甲：确认下周演示 '};
 assert.equal(parseSpeakerSummary(complete).content,'发言人甲：确认下周演示');
 for(const change of [{status:'created'},{innerStatus:'Running'},{success:'true'},{taskId:''},{errorMsg:undefined},{content:''},{content:'x'.repeat(500001)}])assert.notEqual(parseSpeakerSummary({...complete,...change}).state,'ready');
 assert.equal(parseSpeakerSummary({status:'processing',innerStatus:'Running'}).state,'pending');
 assert.equal(parseSpeakerSummary({success:false}).state,'failed');
 assert.equal(parseSpeakerSummary(null).state,'unavailable');
 assert.equal(parseSpeakerSummary({taskId:'created-only'}).state,'unsupported_shape');
 const empty=JSON.stringify({error:{message:'downstream query empty'}});
 assert.equal(isEmptySpeakerQuery(['minutes','speaker','summary','get'],empty),true);
 assert.equal(isEmptySpeakerQuery(['minutes','speaker','summary','create'],empty),false);
 assert.equal(isEmptySpeakerQuery(['minutes','speaker','summary','get'],JSON.stringify({error:{message:'permission denied'}})),false);
});

test('普通同步只读原生发言人结果，只有显式生成才发出 create；鉴权错误不伪装成未生成',async()=>{
 const calls=[];let mode='absent';
 const client=createMinutesClient({profile:'dingTest:123',corpId:'dingTest',userId:'123'},{run:async(_bin,args)=>{
  calls.push(args);
  if(args.slice(0,4).join(' ')==='minutes speaker summary get'){
   if(mode==='absent')throw Object.assign(new Error('missing'),{stdout:JSON.stringify({error:{code:1,message:'downstream query empty'}})});
   if(mode==='error')throw Object.assign(new Error('auth'),{stderr:'permission denied'});
   return {stdout:JSON.stringify({success:true,result:{status:'completed',innerStatus:'Finished',success:true,taskId:'task',errorMsg:'',content:'真实发言人观点'}})};
  }
  if(args.slice(0,4).join(' ')==='minutes speaker summary create')return {stdout:JSON.stringify({success:true,result:{taskId:'task'}})};
  if(args[1]==='get')return {stdout:JSON.stringify({success:true,result:{fullSummary:'真实摘要',generatingStatus:'COMPLETED',textGenerationInfo:{state:'COMPLETED'}}})};
  if(args[1]==='+transcript')return {stdout:JSON.stringify({ok:true,outcome:'success',data:{taskUuid:'note',complete:true,direction:'0',pages:1,paragraphCount:0,paragraphList:[]},meta:{pagination:{endpoint_exhausted:true}}})};
  throw new Error('unexpected command');
 }});
 assert.equal((await client.artifacts('note')).speaker_insights.state,'unavailable');
 assert.equal(calls.filter(x=>x.includes('create')).length,0);
 assert.equal((await client.speakerInsights('note',{generate:true})).state,'pending');
 assert.equal(calls.filter(x=>x.includes('create')).length,1);assert.ok(calls.at(-1).includes('--yes'));
 mode='ready';assert.equal((await client.artifacts('note')).speaker_insights.content,'真实发言人观点');
 mode='error';assert.equal((await client.speakerInsights('note')).state,'failed');
 assert.ok(calls.every(x=>x[x.indexOf('--profile')+1]==='dingTest:123'));
});

async function context(t){
 const upstream={state:'unavailable',creates:0,reads:0,qualityCalls:0,hold:null,onRead:null,text:'客户确认演示，销售约定提供方案。'};
 const client={async verify(){},async transcript(){return {state:'ready',content:upstream.text,reason:''};},async artifacts(){return {transcript:{state:'ready',content:upstream.text,reason:''},quality:{state:'unavailable',content:'',reason:'源接口未提供'}};},async speakerInsights(_id,{generate=false}={}){
  if(generate){upstream.creates++;return speakerPending();}
  upstream.reads++;upstream.onRead?.();if(upstream.hold)await upstream.hold;
  return {state:upstream.state,content:upstream.state==='ready'?'钉钉返回的发言人观点':'',reason:upstream.state==='unavailable'?'尚未生成':''};
 }};
 const f=await fixture(t,{minutesOptions:{enabled:true,corpId:'dingTest',clientFactory:()=>client,qualityComplete:async()=>{upstream.qualityCalls++;return '会议质检：沟通已确认演示安排，预算与决策流程尚未明确。';}}}),sales=await f.login(2),other=await f.login(3),admin=await f.login(1),sourceId=randomUUID();
 const now=new Date().toISOString();
 run(f.db,"INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES(?,2,'dingTest','123','隔离账号','隔离组织',?,'connected',?,?)",sourceId,randomUUID(),now,now);
 const id=Number(run(f.db,"INSERT INTO minutes_records(source_id,external_id,title,start_time,duration_ms,media_state,synced_at) VALUES(?,'native-note','隔离会议',?,60000,'unavailable',?)",sourceId,now,now).lastInsertRowid);
 const post=(actor=sales,generate=false,extra={})=>f.request(`/minutes/records/${id}/speaker-insights`,{actor,method:'POST',body:{generate,...extra}});
 return {...f,sales,other,admin,id,sourceId,upstream,post};
}

test('发言人接口按本人权限运行，重复生成复用进行中任务，只更新该项正文',async t=>{
 const f=await context(t),before=all(f.db,'SELECT * FROM activities ORDER BY id');
 assert.equal((await f.post(f.other,true)).status,404);assert.equal(f.upstream.reads,0);
 assert.equal((await f.post(f.sales,false,{source_id:'other'})).status,400);
 assert.equal((await f.post()).body.state,'unavailable');assert.equal(f.upstream.creates,0);
 assert.equal((await f.post(f.sales,true)).body.state,'pending');assert.equal(f.upstream.creates,1);
 assert.equal((await f.post(f.sales,true)).body.state,'pending');assert.equal(f.upstream.creates,1);
 f.upstream.state='ready';assert.equal((await f.post(f.admin)).body.state,'ready');
 assert.equal(one(f.db,"SELECT content FROM minutes_artifacts WHERE record_id=? AND kind='speaker_insights'",f.id).content,'钉钉返回的发言人观点');
 assert.deepEqual(all(f.db,'SELECT * FROM activities ORDER BY id'),before);
 assert.equal(one(f.db,'SELECT count(*) n FROM minutes_artifacts WHERE record_id=?',f.id).n,1);
 const key=randomUUID(),args={actor:f.sales,method:'POST',body:{generate:true},key};
 await f.request(`/minutes/records/${f.id}/speaker-insights`,args);const reads=f.upstream.reads;
 await f.request(`/minutes/records/${f.id}/speaker-insights`,args);assert.equal(f.upstream.reads,reads);
});

test('读取期间注销、停止连接和并发点击都不会保存失效的发言人结果',async t=>{
 const f=await context(t);let entered,release;const start=new Promise(r=>entered=r);
 f.upstream.hold=new Promise(r=>release=r);f.upstream.onRead=entered;f.upstream.state='ready';
 const waiting=f.post();await start;assert.equal((await f.post()).status,409);
 await f.request('/auth/logout',{actor:f.sales,method:'POST',body:{}});release();assert.equal((await waiting).status,401);
 assert.equal(one(f.db,'SELECT count(*) n FROM minutes_artifacts').n,0);
 f.sales=await f.login(2);f.upstream.hold=null;f.upstream.onRead=()=>run(f.db,"UPDATE minutes_sources SET connection_state='disconnected' WHERE id=?",f.sourceId);
 assert.equal((await f.post(f.admin)).status,409);assert.equal(one(f.db,'SELECT count(*) n FROM minutes_artifacts').n,0);
});

test('两项分析保留明确重读入口，旧占位不冒充正在读取或显示虚假时间，正文转义',()=>{
 const old={state:'unavailable',content:'',checked_at:'2026-10-30T12:11:00Z',reason:'当前连接未返回可核验的发言人观点；未自动创建源平台分析任务'};
 const speaker=minuteArtifact('speaker_insights',old,1,true,'speaker_insights');assert.match(speaker,/当前来源暂未提供/);assert.match(speaker,/data-action="minutes-artifact-retry"/);assert.doesNotMatch(speaker,/正在读取|最近读取|由钉钉生成/);
 const quality=minuteArtifact('quality',old,1,true,'quality');assert.match(quality,/data-action="minutes-artifact-retry"/);assert.doesNotMatch(quality,/正在读取|最近读取|尚未返回|该项尚无可展示正文/);
 const ready=minuteArtifact('speaker_insights',{state:'ready',content:'<script>alert(1)</script>'},1,false,'speaker_insights');assert.match(ready,/&lt;script&gt;/);assert.doesNotMatch(ready,/data-action="minutes-speaker/);
});

test('会议质检自动生成、缓存与原文变更失效均受权限约束，不改业务跟进',async t=>{
 const f=await context(t),route=`/minutes/records/${f.id}/quality`,post=(actor=f.sales)=>f.request(route,{actor,method:'POST',body:{}}),before=all(f.db,'SELECT * FROM activities ORDER BY id');
 assert.equal((await post(f.other)).status,404);assert.equal(f.upstream.qualityCalls,0);
 assert.equal((await post()).body.state,'empty');assert.equal(f.upstream.qualityCalls,0);
 await f.request(`/minutes/records/${f.id}/refresh`,{actor:f.sales,method:'POST',body:{}});
 assert.equal((await post()).body.state,'ready');assert.equal(f.upstream.qualityCalls,1);
 assert.match(one(f.db,"SELECT reason FROM minutes_artifacts WHERE record_id=? AND kind='quality'",f.id).reason,/CRM AI 质检/);
 assert.equal((await post()).body.state,'ready');assert.equal(f.upstream.qualityCalls,1);
 f.upstream.text+='客户补充了新的约束。';await f.request(`/minutes/records/${f.id}/refresh`,{actor:f.sales,method:'POST',body:{}});
 assert.equal(one(f.db,"SELECT state FROM minutes_artifacts WHERE record_id=? AND kind='quality'",f.id).state,'pending');
 assert.equal((await post()).body.state,'ready');assert.equal(f.upstream.qualityCalls,2);
 assert.deepEqual(all(f.db,'SELECT * FROM activities ORDER BY id'),before);
});
test('逐字稿独立自动读取接口按当前账号与档案范围校验，不改手工跟进',async t=>{
 const f=await context(t),route=`/minutes/records/${f.id}/transcript`,before=all(f.db,'SELECT * FROM activities ORDER BY id');
 assert.equal((await f.request(route,{actor:f.other,method:'POST',body:{}})).status,404);
 assert.equal((await f.request(route,{actor:f.sales,method:'POST',body:{generate:true}})).status,400);
 const r=await f.request(route,{actor:f.sales,method:'POST',body:{}});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.state,'ready');
 assert.equal(one(f.db,"SELECT content FROM minutes_artifacts WHERE record_id=? AND kind='transcript'",f.id).content,f.upstream.text);assert.deepEqual(all(f.db,'SELECT * FROM activities ORDER BY id'),before);
});

test('质检仅使用本条可用正文，明确摘要/截断范围，空响应和未完整AI输出不入库',async()=>{
 const input=qualityInput({transcript:{state:'ready',content:'原文内容'.repeat(8000)},summary:{state:'ready',content:'不混入的摘要'}});
 assert.equal(input.messages[1].content.includes('不混入的摘要'),false);assert.equal(JSON.parse(input.messages[1].content).truncated,true);
 await assert.rejects(analyzeQuality(input,async()=>''));assert.equal((await analyzeQuality(qualityInput({}),async()=>{assert.fail('no source must not call AI');})).state,'empty');
 const complete=createQualityComplete({env:{AI_API_KEY:'isolated-key'},fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'截断结果'}}]})})});
 await assert.rejects(complete(input.messages),/未完整返回/);
});
