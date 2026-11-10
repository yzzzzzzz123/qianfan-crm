import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {assert as check,now,AppError} from '../server/domain.mjs';
import {createIntakeAI,normalizeContractExtraction,AI_MODEL,AI_ENDPOINT} from '../server/ai-intake.mjs';
import {migrateContractAnalysis} from '../server/contract-analysis-schema.mjs';
import {createContractAnalysis} from '../server/contract-analysis.mjs';

const raw=(extra={})=>({total_amount:100,payment_stages:[{name:'首付款',amount:30,due_date:'2026-11-10',condition:'按合同约定付款',evidence:'首付款30元，于2026年11月10日前支付。'},{name:'尾款',amount:70,due_date:null,condition:'验收后30天内',evidence:'尾款70元，验收后30天内支付。'}],summary:'总额100元，分两阶段付款。',questions:[],...extra});
const normalized=()=>({model:AI_MODEL,result:normalizeContractExtraction(raw())});
const txt={name:'隔离合同.txt',base64:Buffer.from('隔离测试合同总额100元。首付款30元于2026年11月10日前支付，尾款70元验收后30天内支付。').toString('base64')};
const reply=value=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]})});

test('contract extraction converts exact cents, retains unknowns, flags inconsistent stages and never guesses relative dates',()=>{
 const good=normalizeContractExtraction(raw());assert.equal(good.total_amount,10000);assert.equal(good.payment_stages[0].amount,3000);assert.equal(good.payment_stages[0].due_date,'2026-11-10');assert.equal(good.payment_stages[1].due_date,null);
 const unknown=normalizeContractExtraction(raw({total_amount:null,payment_stages:[{name:'条件款',amount:null,due_date:'2026-12-02',condition:'验收后30天',evidence:'验收后30天支付余款'}]}));
 assert.equal(unknown.total_amount,null);assert.equal(unknown.payment_stages[0].amount,null);assert.equal(unknown.payment_stages[0].due_date,null);assert.ok(unknown.questions.some(q=>q.includes('日期')));assert.ok(unknown.questions.some(q=>q.includes('总金额')));
 const mismatch=normalizeContractExtraction(raw({total_amount:101}));assert.ok(mismatch.questions.some(q=>q.includes('合计与合同总额不一致')));
 assert.throws(()=>normalizeContractExtraction(raw({total_amount:1.001})),/两位小数/);
 assert.throws(()=>normalizeContractExtraction({...raw(),operations:[{type:'payment'}]}),/结构无效/);
 assert.throws(()=>normalizeContractExtraction(raw({payment_stages:[{...raw().payment_stages[0],due_date:'2026-02-30'}]})),/日期.*无效/);
 const explicitZero=normalizeContractExtraction(raw({total_amount:0,payment_stages:[]}));assert.equal(explicitZero.total_amount,0);
 const many=normalizeContractExtraction(raw({total_amount:null,payment_stages:Array.from({length:60},(_,i)=>({name:`待核对阶段${i+1}`,amount:null,due_date:'2026-12-01',condition:'验收后30天',evidence:'验收后30天支付余款'}))}));
 assert.ok(many.questions.length>100);assert.ok(many.questions.some(q=>q.includes('总金额尚未')));assert.deepEqual(normalizeContractExtraction(many,{amountsInCents:true}),many);
});
test('fixed-model contract provider reuses original document parser and sends only that attachment, never operations or CRM catalog',async()=>{
 let request,parsedFile;
 const ai=createIntakeAI({env:{AI_API_KEY:'isolated-key'},fileParser:async file=>{parsedFile=file;return {text:'隔离原文',images:[{mime:'image/jpeg',base64:'AA=='}]};},fetcher:async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return reply(raw());}});
 const result=await ai.extractContract(txt);assert.deepEqual(parsedFile,txt);assert.equal(request.url,AI_ENDPOINT);assert.equal(request.body.model,AI_MODEL);assert.equal(request.options.redirect,'error');assert.equal(request.body.messages[1].content.length,2);assert.equal(request.body.messages[1].content[1].image_url.url,'data:image/jpeg;base64,AA==');
 const sent=JSON.parse(request.body.messages[1].content[0].text);assert.deepEqual(Object.keys(sent),['filename','original_text']);assert.equal(result.result.total_amount,10000);assert.equal(result.model,AI_MODEL);assert.equal(Object.hasOwn(result,'operations'),false);
});
test('provider enforces file/image limits, incomplete output and fixed schema without external calls on invalid input',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return reply(raw());};
 await assert.rejects(createIntakeAI({env:{},fetcher}).extractContract(txt),/尚未配置/);assert.equal(calls,0);
 const many=createIntakeAI({env:{AI_API_KEY:'isolated-key'},fetcher,fileParser:async()=>({text:'x',images:Array.from({length:9},()=>({mime:'image/jpeg',base64:'AA=='}))})});
 await assert.rejects(many.extractContract(txt),/8张图片/);assert.equal(calls,0);
 await assert.rejects(many.extractContract({name:'large.txt',base64:Buffer.alloc(10*1024*1024+1).toString('base64')}),/10MB/);assert.equal(calls,0);
 await assert.rejects(many.extractContract({...txt,name:'bad.exe'}),/请上传/);assert.equal(calls,0);
 const parsed=async()=>({text:'隔离合同',images:[]});
 const truncated=createIntakeAI({env:{AI_API_KEY:'isolated-key'},fileParser:parsed,fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})})});await assert.rejects(truncated.extractContract(txt),/未完成/);
 const malicious=createIntakeAI({env:{AI_API_KEY:'isolated-key'},fileParser:parsed,fetcher:async()=>reply({...raw(),operations:[]})});await assert.rejects(malicious.extractContract(txt),/结构无效/);
});
test('synthetic original text uses the existing Python document parser without a real API',async()=>{
 let sent;
 const ai=createIntakeAI({env:{AI_API_KEY:'isolated-key'},fetcher:async(url,options)=>{sent=JSON.parse(JSON.parse(options.body).messages[1].content[0].text);return reply(raw());}});
 const value=await ai.extractContract(txt);assert.equal(sent.original_text,Buffer.from(txt.base64,'base64').toString());assert.equal(value.result.payment_stages.length,2);
});

async function setup(t,provider={configured:true,model:AI_MODEL,extractContract:async()=>normalized()}){
 const f=await fixture(t);migrateContractAnalysis(f.db);
 const actor=one(f.db,'SELECT * FROM users WHERE id=1');
 const scoped=(table,id,user)=>{const row=one(f.db,`SELECT * FROM ${table} WHERE id=?`,Number(id));check(row,'记录不存在',404);check(user.role==='admin'||user.role==='sales'&&row.owner_id===user.id,'无权操作此记录',403);return row;};
 const audit=(user,action,entity,id,detail)=>run(f.db,'INSERT INTO audit(user_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)',user.id,action,entity,id,JSON.stringify(detail),now());
 const content=Buffer.from(txt.base64,'base64');
 const attachmentId=Number(run(f.db,"INSERT INTO attachments(entity,entity_id,filename,mime_type,size,sha256,content,created_at) VALUES('contract',1,?,?,?,?,?,?)",txt.name,'text/plain',content.length,createHash('sha256').update(content).digest('hex'),content,now()).lastInsertRowid);
 return {...f,actor,attachmentId,provider,analysis:createContractAnalysis({db:f.db,ai:provider,scoped,audit})};
}
const facts=db=>JSON.stringify({contracts:all(db,'SELECT * FROM contracts ORDER BY id'),items:all(db,'SELECT * FROM contract_items ORDER BY id'),payments:all(db,'SELECT * FROM payments ORDER BY id')});
test('saved extraction is independent, deduplicates successful fingerprint and respects current ownership and PM restrictions',async t=>{
 let calls=0;const f=await setup(t,{configured:true,model:AI_MODEL,extractContract:async()=>{calls++;f.db.exec('BEGIN IMMEDIATE; ROLLBACK');return normalized();}}),before=facts(f.db);let authorizationChecks=0;
 assert.equal(f.analysis.describe(1,f.actor),null);
 const result=await f.analysis.extract(f.actor,1,f.attachmentId,{authorize:()=>{authorizationChecks++;}});assert.equal(result.state,'ready');assert.equal(result.result.total_amount,10000);assert.equal(authorizationChecks,2);assert.equal(facts(f.db),before);
 assert.deepEqual(await f.analysis.extract(f.actor,1,f.attachmentId),result);assert.equal(calls,1);assert.equal(one(f.db,'SELECT count(*) n FROM contract_attachment_analyses').n,1);
 const owner=one(f.db,'SELECT u.* FROM users u JOIN contracts c ON c.owner_id=u.id WHERE c.id=1'),other=one(f.db,"SELECT * FROM users WHERE role='sales' AND id!=?",owner.id);
 assert.equal(f.analysis.describe(1,owner).state,'ready');assert.throws(()=>f.analysis.describe(1,other),e=>e.status===403);await assert.rejects(f.analysis.extract(owner,1,f.attachmentId),e=>e.status===403);
 run(f.db,"INSERT INTO users(id,name,username,role,created_at) VALUES(99,'隔离PM','analysis_pm','pm',?)",now());const pm=one(f.db,'SELECT * FROM users WHERE id=99');assert.throws(()=>f.analysis.describe(1,pm),e=>e.status===403);
 run(f.db,'UPDATE contracts SET owner_id=? WHERE id=1',other.id);assert.throws(()=>f.analysis.describe(1,owner),e=>e.status===403);assert.equal(f.analysis.describe(1,other).state,'failed');
});
test('network completion rechecks authorization, current user, contract and attachment fingerprint and never saves stale output',async t=>{
 for(const mode of ['authorization','role','contract','attachment'])await t.test(mode,async t=>{
  let f,checks=0;
  f=await setup(t,{configured:true,model:AI_MODEL,extractContract:async()=>{
   if(mode==='role')run(f.db,"UPDATE users SET role='sales' WHERE id=1");
   if(mode==='contract')run(f.db,"UPDATE contracts SET scope='读取期间变更' WHERE id=1");
   if(mode==='attachment'){const content=Buffer.from('新的隔离合同');run(f.db,'UPDATE attachments SET content=?,size=?,sha256=? WHERE id=?',content,content.length,createHash('sha256').update(content).digest('hex'),f.attachmentId);}
   return normalized();
  }});
  await assert.rejects(f.analysis.extract(f.actor,1,f.attachmentId,{authorize:()=>{checks++;if(mode==='authorization'&&checks===2)throw new AppError('测试撤销授权',403);}}),e=>[403,409].includes(e.status));
  assert.equal(one(f.db,'SELECT count(*) n FROM contract_attachment_analyses').n,0);
 });
});
test('unconfigured, unsupported and model failures are honest persisted states and never overwrite business facts',async t=>{
 for(const mode of ['unconfigured','unsupported','failure','wrong-model'])await t.test(mode,async t=>{
  let calls=0;const f=await setup(t,{configured:mode!=='unconfigured',model:mode==='wrong-model'?'other-model':AI_MODEL,extractContract:async()=>{calls++;throw new Error('secret-sensitive-upstream-details');}}),before=facts(f.db);
  if(mode==='unsupported')run(f.db,"UPDATE attachments SET filename='archive.exe' WHERE id=?",f.attachmentId);
  const result=await f.analysis.extract(f.actor,1,f.attachmentId);assert.equal(result.state,'failed');assert.equal(result.result.total_amount,null);assert.deepEqual(result.result.payment_stages,[]);assert.equal(facts(f.db),before);assert.equal(calls,mode==='failure'?1:0);assert.equal(JSON.stringify(result).includes('secret-sensitive'),false);
  assert.equal(f.analysis.describe(1,f.actor).state,'failed');
 });
});
test('saving and audit are atomic; corrupt or foreign attachments never reach the model',async t=>{
 let calls=0;const f=await setup(t,{configured:true,model:AI_MODEL,extractContract:async()=>{calls++;return normalized();}});
 await assert.rejects(f.analysis.extract(f.actor,2,f.attachmentId),e=>e.status===404);assert.equal(calls,0);
 run(f.db,"UPDATE attachments SET sha256='incorrect' WHERE id=?",f.attachmentId);await assert.rejects(f.analysis.extract(f.actor,1,f.attachmentId),e=>e.status===409);assert.equal(calls,0);
 run(f.db,'UPDATE attachments SET sha256=? WHERE id=?',createHash('sha256').update(Buffer.from(txt.base64,'base64')).digest('hex'),f.attachmentId);
 f.db.exec("CREATE TRIGGER analysis_audit_failure BEFORE INSERT ON audit WHEN NEW.action='提取合同附件信息' BEGIN SELECT RAISE(ABORT,'isolated analysis audit failure'); END;");
 await assert.rejects(f.analysis.extract(f.actor,1,f.attachmentId),/isolated analysis audit failure/);assert.equal(one(f.db,'SELECT count(*) n FROM contract_attachment_analyses').n,0);
});
test('manual HTTP extraction requires admin, preserves idempotency and exposes saved results only on the current permitted contract',async t=>{
 let calls=0;const provider={configured:true,model:AI_MODEL,extractContract:async()=>{calls++;return normalized();}};
 const f=await fixture(t,{aiProvider:provider});migrateContractAnalysis(f.db);
 const content=Buffer.from(txt.base64,'base64'),attachmentId=Number(run(f.db,"INSERT INTO attachments(entity,entity_id,filename,mime_type,size,sha256,content,created_at) VALUES('contract',1,?,?,?,?,?,?)",txt.name,'text/plain',content.length,createHash('sha256').update(content).digest('hex'),content,now()).lastInsertRowid);
 const admin=await f.login(1),sales=await f.login(2),path='/contracts/1/extract-attachment',body={attachment_id:attachmentId},key=randomUUID(),before=facts(f.db);
 assert.equal((await f.request(path,{actor:sales,method:'POST',body})).status,403);
 const first=await f.request(path,{actor:admin,method:'POST',body,key});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.state,'ready');assert.equal(first.body.result.total_amount,10000);
 const second=await f.request(path,{actor:admin,method:'POST',body,key});assert.deepEqual(second.body,first.body);assert.equal(calls,1);assert.equal(facts(f.db),before);
 const state=(await f.request('/state',{actor:sales})).body;assert.equal(state.contracts.find(c=>c.id===1).contract_analysis.state,'ready');
 assert.equal((await f.request(path,{actor:admin,method:'POST',body:{attachment_id:attachmentId+1000},key})).status,404);
});
