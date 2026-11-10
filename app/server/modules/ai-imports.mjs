import { createHash } from 'node:crypto';
import { all, one } from '../database.mjs';
import { assert, now, text, normalize } from '../domain.mjs';
import { inputHash, validateUpload } from '../ai-intake.mjs';

import {intakeSchema as definitions,fieldNames,intakeTypes,intakeRelations,intakeAliases,aliasFields,operationFields} from '../../public/modules/intake-schema.js';
import {operationDestinations,batchRecords} from './intake-receipts.mjs';
import {integrationSettings} from './setup.mjs';
import {attachContractFile} from './source-records.mjs';
import {intakeStorageMatches} from './intake-fields.mjs';
import {canManageContractData} from '../contract-access.mjs';
export {fieldNames};
const hasValue=value=>value!==undefined&&value!==null&&(typeof value!=='string'||value.trim()!=='')&&(!Array.isArray(value)||value.length>0);
const aliases=intakeAliases;
const revision=db=>one(db,'SELECT revision FROM workspace_revision WHERE id=1').revision;
export function intakeCatalog(state) {
  const commissionFields=['period','threshold','low_rate','high_rate','manager_id','unlock_by_payment','sales_policy'];
  const rules={...state.rules,commission:Object.fromEntries(Object.entries(state.rules.commission||{}).filter(([key])=>commissionFields.includes(key)))};
  return {today:state.today,actor:{name:state.actor.name,role:state.actor.role},records:{
    users:state.users.map(u=>({id:u.id,name:u.name,username:u.username,role:u.role,active:u.active})),
    customers:state.customers.filter(c=>!c.shared).map(c=>({id:c.id,name:c.name,owner_id:c.owner_id})),
    contacts:state.contacts.filter(c=>state.customers.some(customer=>customer.id===c.customer_id&&!customer.shared)).map(c=>({id:c.id,customer_id:c.customer_id,name:c.name,title:c.title})),
    opportunities:state.opportunities.map(o=>({id:o.id,name:o.name,code:o.code,customer_id:o.customer_id,owner_id:o.owner_id,stage:o.stage,reference:o.reference})),
    contracts:state.contracts.map(c=>({id:c.id,name:c.name,contract_no:c.contract_no,code:c.code,customer_id:c.customer_id,outstanding:c.outstanding/100,items:c.items.map(i=>({id:i.id,name:i.name,kind:i.kind,amount:i.amount/100})),payments:c.payments.map(p=>({id:p.id,amount:p.amount/100,status:p.status}))})),
    ...(state.actor.role==='admin'?{configuration:{documents:state.integrationSettings.documents},rules,performance:state.performance.map(p=>({user_id:p.user_id,name:p.name,month:p.month,status:p.status})),commission_previews:(state.commission.realtime_previews||[]).map(p=>({sales_id:p.sales_id,name:p.name,kind:p.kind,period:p.period,base:p.base/100,rate:p.rate,estimated_total:p.estimated_total==null?null:p.estimated_total/100,issues:p.issues,read_only:true})),commission_batches:state.commission.batches.map(b=>({id:b.id,sales_id:b.sales_id,kind:b.kind,period:b.period,amount:b.amount/100,status:b.status}))}:{}),
  }};
}
function resolveOperations(ctx, operations, state) {
  const refs=new Map(),named=new Map(),resolved=[];
  const filenames=(ctx.sourceFiles||[]).map(file=>file.name||file.filename);
  const registerName=(collection,field,value,ref)=>{if(!hasValue(value))return;const key=`${collection}:${field}:${normalize(String(value))}`;if(!named.has(key))named.set(key,new Set());named.get(key).add('$'+ref);};
  const priority={member:0,customer:1,opportunity:2,contact:2,activity:3,quote:3,contract:4,contract_attachment:5,contract_archive:5,payment:6,target:6};
  const ordered=[...operations].sort((a,b)=>(priority[a?.type]??6)-(priority[b?.type]??6));
  for(const op of ordered) {
    assert(op&&typeof op==='object'&&!Array.isArray(op)&&Object.hasOwn(definitions,op.type),'AI包含不支持的数据类型，禁止入库');
    assert(['create','update'].includes(op.action),'AI操作类型无效');
    assert(op.data&&typeof op.data==='object'&&!Array.isArray(op.data),'AI数据字段无效');
    const def=definitions[op.type],data=structuredClone(op.data),resolutionErrors=[];
    const fixed=operationFields(op.type,op.action);
    const allowed=new Set([...fixed,...aliases.filter(alias=>fixed.includes(aliasFields[alias]))]);
    assert(Object.keys(data).every(k=>allowed.has(k)),'AI草稿包含未授权字段，禁止入库');
    const ref=op.ref||`row${resolved.length+1}`;assert(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/.test(ref)&&!refs.has(ref),'本批引用编号无效或重复');
    for(const key of [...Object.keys(intakeRelations),'entity_id']) {
      const value=data[key];
      if(value&&typeof value==='object') {
        assert(!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.$ref==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/.test(value.$ref),`${fieldNames[key]||key}的本批引用格式无效`);
        data[key]='$'+value.$ref;
      }
    }
    for(const [alias,key,collection,nameField] of [['customer_name','customer_id','customers','name'],['opportunity_name','opportunity_id','opportunities','name'],['contract_no','contract_id','contracts','contract_no'],['owner_name','owner_id','users','name'],['user_name','user_id','users','name'],['sales_name','sales_id','users','name']]) {
      if(alias==='contract_no'&&op.type==='contract')continue;
      if(hasValue(data[alias])) {
        const name=typeof data[alias]==='string'?data[alias].trim():'';
        const matches=state[collection].filter(x=>(collection!=='customers'||!x.shared)&&[x[nameField],x.code,x.username].filter(Boolean).includes(name));
        const candidates=[...new Set([...matches.map(x=>x.id),...(named.get(`${collection}:${nameField}:${normalize(name)}`)||[])])];
        if(hasValue(data[key])) {
          if(!candidates.some(value=>String(value)===String(data[key])))resolutionErrors.push(`${fieldNames[key]||key}的名称与编号不一致，请核对资料`);
        } else data[key]=candidates.length===1?candidates[0]:`?未唯一匹配：${name}`;
      }
      delete data[alias];
    }
    const memberIdentifier=value=>{
      if(value&&typeof value==='object') {
        assert(!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.$ref==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/.test(value.$ref),'协作成员的本批引用格式无效');
        return '$'+value.$ref;
      }
      if(typeof value!=='string'||value.startsWith('$')||/^\d+$/.test(value))return value;
      const name=value.trim(),matches=state.users.filter(user=>[user.name,user.username].filter(Boolean).includes(name));
      return matches.length===1?matches[0].id:`?未唯一匹配：${name}`;
    };
    if(hasValue(data.collaborator_pm))data.collaborator_pm=memberIdentifier(data.collaborator_pm);
    if(Array.isArray(data.collaborators))data.collaborators=data.collaborators.map(memberIdentifier);
    // Do not accept client/model SQL, paths, credentials, privilege flags or default guesses.
    assert(op.target_id===undefined||op.target_id===null||Number.isSafeInteger(op.target_id)&&op.target_id>0,'目标记录ID无效');
    let source=typeof op.source_file==='string'?op.source_file.trim():'';
    if(op.type==='ppl_snapshot'&&typeof data.source_file==='string')source=data.source_file;
    if(!filenames.length)source='粘贴内容';
    else if(['粘贴内容','补充说明','用户说明'].includes(source)&&hasValue(ctx.sourceText))source='粘贴内容';
    else if(!filenames.includes(source))resolutionErrors.push('记录来源不在本批附件中，请明确原文件或粘贴内容');
    const clean={type:op.type,action:op.action,ref,data,input_data:structuredClone(op.data),...(resolutionErrors.length?{resolution_errors:resolutionErrors}:{}),...(op.target_id?{target_id:op.target_id}:{}),source_file:source.slice(0,200),evidence:typeof op.evidence==='string'?op.evidence.slice(0,2000):''};
    refs.set(ref,true);
    if(op.action==='create'&&def.table) {
      if(op.type!=='contract')registerName(def.table,'name',data.name,ref);
      if(op.type==='member')registerName('users','name',data.username,ref);
      if(op.type==='contract')registerName('contracts','contract_no',data.contract_no,ref);
    }
    resolved.push(clean);
  }
  return resolved;
}
function applyOperation(ctx,op,refs) {
  const def=definitions[op.type];assert(def,'不支持此数据类型');
  assert(!op.resolution_errors?.length,op.resolution_errors?.join('；'));
  assert(op.action!=='update'||def.table||def.suffix||['document_template','document_template_approve','rules','commission_confirm'].includes(op.type),'此记录类型不能直接修改，请提供正确的业务操作；禁止把更新当作新增');
  assert(def.actionRoles[op.action]?.includes(ctx.actor.role),def.adminOnly?'此类资料仅管理员可录入或修改':'当前角色不能录入或修改此类资料',403);
  assert(op.type!=='contract_item'||op.action==='update','合同行项只能通过已有行项ID维护');
  assert(!op.target_id||op.action==='update'||def.suffix,'新增记录不能同时指定已有记录编号，请明确新增或修改');
  const data=structuredClone(op.data);
  assert(Object.keys(data).length,'文档没有需要写入的业务字段');
  assert(Object.keys(data).every(key=>operationFields(op.type,op.action,ctx.actor.role).includes(key)),'AI草稿包含当前角色或操作不支持的字段，请重新识别资料');
  for(const key of ['duplicate_ack','additional','active','performance_enabled','confirmed','both_stamped'])if(data[key]!==undefined)assert(typeof data[key]==='boolean',`${fieldNames[key]||key}须明确填写是或否`);
  for(const key of ['customer_id','opportunity_id','contract_id','owner_id','user_id','entity_id','collaborator_pm','sales_id']) if(data[key]!==undefined&&data[key]!==null&&data[key]!=='') {
    if(typeof data[key]==='string'&&data[key].startsWith('$')) {
      const related=refs.get(data[key].slice(1));assert(related,`关联的本批记录尚未通过校验：${data[key]}`);
      const expected=key==='entity_id'?data.entity:intakeRelations[key];
      assert(related.type===expected,`${fieldNames[key]||key}须关联${intakeTypes[expected]||'对应类型'}，不能关联${intakeTypes[related.type]||'其他类型'}`);data[key]=related.id;
    }
    assert((typeof data[key]==='number'||typeof data[key]==='string'&&/^\d+$/.test(data[key]))&&Number.isSafeInteger(Number(data[key]))&&Number(data[key])>0,`${fieldNames[key]||key}无法唯一匹配，请填写准确名称或编号`);data[key]=Number(data[key]);
  }
  if(data.collaborators!==undefined) {
    assert(Array.isArray(data.collaborators)&&data.collaborators.length<=30,'协作成员须为最多30人的列表');
    data.collaborators=data.collaborators.map(value=>{
      if(typeof value==='string'&&value.startsWith('$')) {
        const related=refs.get(value.slice(1));assert(related,'关联的本批协作成员尚未通过校验');assert(related.type==='member','协作成员须引用团队成员，不能关联其他业务记录');value=related.id;
      }
      assert((typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0,'协作成员无法唯一匹配，请填写准确姓名、账号或编号');return Number(value);
    });
  }
  if(['customer','opportunity'].includes(op.type)&&op.action==='update')assert(Object.keys(data).some(key=>key!=='reason'),'请明确需要调整的字段，不能只填写原因');
  if(op.type==='rules')for(const [key,value] of Object.entries(data))assert(key==='customer_levels'?Array.isArray(value)&&value.length>0:value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length>0,`${fieldNames[key]}须明确提供需要修改的规则项`);
  const required=op.action==='update'?(def.updateRequired||(def.table?[]:def.required)):def.required;
  const missing=required.filter(key=>!hasValue(data[key]));
  assert(!missing.length,`文档缺少必填字段：${missing.map(key=>fieldNames[key]||key).join('、')}`);
  if(op.action==='create')for(const group of def.requiredAny||[])assert(group.some(key=>hasValue(data[key])),`文档缺少必填信息：${group.map(key=>fieldNames[key]||key).join('、')}至少一项`);
  if(['customer','opportunity','contract'].includes(op.type)&&ctx.actor.role==='sales'&&data.owner_id!==undefined)assert(data.owner_id===ctx.actor.id,'销售只能维护本人负责的记录，文档负责人须与当前账号一致',403);
  if(op.type==='contract'&&op.action!=='update') {
    assert(data.opportunity_id||data.customer_id,'文档缺少必填字段：关联商机或关联客户');
  }
  if(def.itemsSchema&&op.action==='create'){
    const spec=def.itemsSchema;assert(Array.isArray(data.items)&&data.items.length>=spec.minimum&&data.items.length<=spec.maximum,`${spec.label}须包含${spec.minimum}至${spec.maximum}条记录`);
    for(const [index,item] of data.items.entries()) {
      assert(item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).every(k=>spec.fields.includes(k)),`${spec.label}包含不支持字段`);
      const absent=spec.required.filter(k=>!hasValue(item[k]));assert(!absent.length,`第${index+1}条${spec.label}缺少：${absent.map(k=>({name:'名称',kind:'类型',quantity:'数量',list_price:'原价单价',amount:'金额'}[k]||fieldNames[k]||k)).join('、')}`);
    }
  }
  assert(intakeStorageMatches(ctx.db,op.type,data),'业务字段与当前数据库结构不一致，请联系管理员核对后重新识别');
  if(op.type==='payment')assert(data.status==='已到账'?hasValue(data.pay_date):hasValue(data.promise_date),data.status==='已到账'?'文档缺少必填字段：实际到账日期':'文档缺少必填字段：预计收款日');
  if(['contract_attachment','contract_archive'].includes(op.type)) {
    const contractId=op.target_id||data.contract_id;
    assert(contractId,'请明确已有合同编号或本批合同引用');
    assert(!op.target_id||!data.contract_id||op.target_id===data.contract_id,'合同名称与归档编号不一致');
    let attachmentId=null;
    if(hasValue(data.source_file)){
      const files=(ctx.sourceFiles||[]).filter(f=>(f.name||f.filename)===data.source_file);
      assert(files.length===1,'须选择本批唯一同名的原始合同附件');
      attachmentId=attachContractFile(ctx,contractId,files[0]);
    }else assert(op.type==='contract_archive','请提供要保存的合同附件');
    if(op.type==='contract_archive') {
      assert(data.both_stamped===true,'请明确确认合同已经签署');
      const contract=ctx.scoped('contracts',contractId,ctx.actor);
      // A freshly registered contract is already signed. A redundant explicit
      // confirmation without a file must not fabricate an attachment or filing.
      const result=contract.lifecycle==='已归档'&&!attachmentId
        ?{id:contract.id,message:'合同已签署，附件可后补'}
        :ctx.mutate(`/api/contracts/${contractId}/archive`,'POST',{both_stamped:true,...(attachmentId?{archive_attachment_id:attachmentId}:{})},ctx.actor);
      return {type:op.type,ref:op.ref,id:contractId,message:result.message,...(!ctx.previewOnly?{action:op.action,source_file:op.source_file,destinations:operationDestinations(ctx.db,op,data,contractId)}:{})};
    }
    return {type:op.type,ref:op.ref,id:attachmentId,message:'合同附件已保存',...(!ctx.previewOnly?{action:op.action,source_file:op.source_file,destinations:operationDestinations(ctx.db,op,data,attachmentId)}:{})};
  }
  let path='/api'+def.path,method='POST',body=data;
  if(def.suffix) {assert(op.target_id,'文档缺少必填字段：已有记录ID');path+=`/${op.target_id}${def.suffix}`;}
  else if(op.action==='update'&&def.table) {assert(op.target_id,'文档缺少必填字段：要更新的已有记录ID');path+=`/${op.target_id}`;method='PATCH';}
  if(op.type==='document_template') {
    const effective=op.action==='update'?{...integrationSettings(ctx.db).documents,...data}:data;
    assert(hasValue(effective.issuer),'文档缺少必填字段：签约主体');assert(hasValue(effective.quote)||hasValue(effective.contract),'文档缺少报价或合同模板正文');method='PATCH';body={documents:{...data,confirmed:false}};
  }
  if(op.type==='document_template_approve') {assert(data.confirmed===true,'请明确批准已核对的公司模板');method='PATCH';body={documents:{confirmed:true}};}
  if(op.type==='rules')method='PATCH';
  if(op.type==='member'&&op.action==='create')body={...data,dingtalk_only:true};
  // A user-supplied reason authorizes a correction of the current ledger, not
  // a rewrite of an already confirmed settlement. The service still scopes
  // every target to the sales member before accepting the correction.
  if(canManageContractData(ctx.actor)&&hasValue(data.reason)&&((op.type==='contract'&&op.action==='update')||['contract_item','payment_allocation'].includes(op.type)))body={...body,data_correction:true};
  const result=ctx.mutate(path,method,body,ctx.actor);
  if(result?.id)refs.set(op.ref,{id:result.id,type:op.type});
  const id=result?.id||op.target_id||null;
  return {type:op.type,ref:op.ref,id,message:result.message,...(!ctx.previewOnly?{action:op.action,source_file:op.source_file,destinations:operationDestinations(ctx.db,op,data,id)}:{})};
}
function preview(ctx,operations) {
  const refs=new Map(),errors=[];ctx={...ctx,previewOnly:true};ctx.db.exec('SAVEPOINT ai_preview');
  try {
    for(const [index,op] of operations.entries()) {
      ctx.db.exec('SAVEPOINT ai_row');
      try {applyOperation(ctx,op,refs);ctx.db.exec('RELEASE ai_row');}
      catch(error) {ctx.db.exec('ROLLBACK TO ai_row; RELEASE ai_row');errors.push({index,ref:op.ref,source_file:op.source_file,record:op.data.name||op.data.summary||op.type,message:error.status?error.message:'字段或关联关系不满足数据库规范，请核对资料'});}
    }
  } finally {ctx.db.exec('ROLLBACK TO ai_preview; RELEASE ai_preview');}
  return errors;
}
export function readBatch(db,id,actor) {
  const row=one(db,'SELECT * FROM ai_import_batches WHERE id=?',id);assert(row,'接收批次不存在',404);assert(actor.role==='admin'||row.user_id===actor.id,'无权查看其他成员的上传资料',403);
  assert(row.source_role!=='admin'||actor.role==='admin','原批次包含管理资料，当前角色无权访问',403);
  const batch={...row,source_context:JSON.parse(row.source_context),questions:JSON.parse(row.questions),operations:JSON.parse(row.operations),errors:JSON.parse(row.errors),usage:JSON.parse(row.usage),result:row.result?JSON.parse(row.result):null,files:all(db,'SELECT id,filename,length(content) bytes FROM ai_uploads WHERE batch_id=?',row.id)};
  return {...batch,records:batchRecords(db,batch)};
}
function duplicateSourceErrors(db,actor,operations,hashes) {
  if(!hashes.length||!operations.some(op=>op.action==='create'))return [];
  const already=one(db,`SELECT 1 FROM ai_uploads u JOIN ai_import_batches b ON b.id=u.batch_id WHERE b.state='confirmed' AND b.user_id=? AND u.sha256 IN (${hashes.map(()=>'?').join(',')}) LIMIT 1`,actor.id,...hashes);
  return already?[{index:-1,record:'原始附件',message:'附件已有成功入库记录，禁止再次新增同一资料；修改已有记录时请明确修改对象和字段'}]:[];
}
function unresolvedQuestions(questions,files) {
  return questions.map(message=>({index:-1,record:'待补充资料',source_file:files.map(f=>f.name||f.filename).join('、')||'补充说明',message}));
}
export function saveIntake(ctx,b,prepared) {
  const {actor,db,insert,audit,state}=ctx;
  const previous=one(db,'SELECT id FROM ai_import_batches WHERE user_id=? AND source_hash=?',actor.id,inputHash(b));
  if(previous)return {id:previous.id,message:'相同资料已有接收记录，请查看原批次，避免重复入库'};
  const operations=resolveOperations({...ctx,sourceFiles:b.files||[],sourceText:b.text||''},prepared.operations,state(actor));
  const errors=preview({...ctx,sourceFiles:b.files||[]},operations);
  errors.push(...unresolvedQuestions(prepared.questions,b.files||[]));
  const knownFiles=(b.files||[]).map(f=>createHash('sha256').update(Buffer.from(f.base64,'base64')).digest('hex'));
  errors.push(...duplicateSourceErrors(db,actor,operations,knownFiles));
  if(!operations.length)errors.push({index:-1,ref:'',record:'本批资料',message:'未识别到可入库记录，请按规范补齐业务字段或说明资料用途'});
  const id=insert('ai_import_batches',{user_id:actor.id,source_hash:inputHash(b),summary:prepared.summary,questions:JSON.stringify(prepared.questions),operations:JSON.stringify(operations),errors:JSON.stringify(errors),model:prepared.model,usage:JSON.stringify(prepared.usage),source_text:b.text||'',source_context:JSON.stringify(b.context||{}),source_role:actor.role,base_revision:revision(db),created_at:now()});
  for(const file of b.files||[]) {const content=Buffer.from(file.base64,'base64');insert('ai_uploads',{batch_id:id,filename:file.name,sha256:createHash('sha256').update(content).digest('hex'),content});}
  audit(actor,errors.length?'AI资料校验未通过':'AI资料已生成待确认草稿','ai_import',id,{count:operations.length,errors:errors.length,model:prepared.model});
  return {id,valid:!errors.length,message:errors.length?`有${errors.length}项缺失或不符合规范，整批禁止入库`:`已识别${operations.length}条操作，校验通过后等待确认入库`};
}
export function handleAIImports(ctx) {
  const {path,method,b,actor,db,update,audit}=ctx;
  const match=path.match(/^\/api\/ai\/batches\/(\d+)\/(validate|confirm|cancel)$/);
  if(!match||method!=='POST')return;
  const batch=readBatch(db,Number(match[1]),actor);
  ctx={...ctx,sourceFiles:all(db,'SELECT filename name,content FROM ai_uploads WHERE batch_id=?',batch.id)};
  assert(batch.state==='draft','该批次已处理，不能重复执行',409);
  if(match[2]==='cancel') {update('ai_import_batches',batch.id,{state:'cancelled'});audit(actor,'取消AI接收批次','ai_import',batch.id);return {id:batch.id,message:'已取消，业务数据未写入'};}
  if(match[2]==='validate') {
    const operations=resolveOperations({...ctx,sourceFiles:batch.files,sourceText:batch.source_text},batch.operations.map(op=>({...op,data:op.input_data||op.data})),ctx.state(actor));
    const errors=preview(ctx,operations);
    errors.push(...unresolvedQuestions(batch.questions,batch.files));
    errors.push(...duplicateSourceErrors(db,actor,operations,all(db,'SELECT sha256 FROM ai_uploads WHERE batch_id=?',batch.id).map(f=>f.sha256)));
    if(!operations.length)errors.push({index:-1,record:'本批资料',message:'没有可入库操作'});
    update('ai_import_batches',batch.id,{operations:JSON.stringify(operations),errors:JSON.stringify(errors),base_revision:revision(db),version:batch.version+1});
    return {id:batch.id,valid:!errors.length,message:errors.length?'校验未通过，禁止入库':'已按当前数据库重新校验，请核对后确认'};
  }
  assert(b.version===batch.version,'预览已变化，请刷新并重新核对',409);
  assert(b.acknowledged===true,'请先核对预览并明确确认执行',400);
  assert(batch.errors.length===0&&batch.operations.length>0,'资料存在缺失或错误，整批禁止入库，请补齐文档重新提交',422);
  assert(batch.base_revision===revision(db),'业务数据已变化，请点击重新校验并核对最新预览',409);
  const refs=new Map(),result=[];
  for(const op of batch.operations)result.push(applyOperation(ctx,op,refs));
  update('ai_import_batches',batch.id,{state:'confirmed',confirmed_at:now(),result:JSON.stringify(result)});
  audit(actor,'确认AI资料入库','ai_import',batch.id,{count:result.length,model:batch.model});
  return {id:batch.id,message:`${result.length}条操作已全部入库`,result};
}
export async function prepareIntake(ctx,b,ai) {
  validateUpload(b);
  const previous=one(ctx.db,'SELECT id FROM ai_import_batches WHERE user_id=? AND source_hash=?',ctx.actor.id,inputHash(b));
  if(previous)return {existingId:previous.id};
  return ai.prepare(b,intakeCatalog(ctx.state(ctx.actor)));
}
