import {esc,icon,badge,sectionHead,actionButton as button} from '../ui.js';

import {intakeSchema,intakeStorage,intakeItemStorage,storageTargetLabel,intakeTypes,intakeDestinations,fieldNames as labels,operationFields} from './intake-schema.js';
import {visibleGuideGroups,guideFields,intakeFieldLabel} from './intake-guide.js';
export {intakeTypes};
const itemLabels={name:'名称',kind:'类型',quantity:'数量',list_price:'原单价（元）',discount_rate:'折后比例',amount:'金额（元）',list_amount:'原价合计（元）'};
function valueView(value,key,S,operations,type) {
  const collection={customer_id:'customers',opportunity_id:'opportunities',contract_id:'contracts',owner_id:'users',user_id:'users',sales_id:'users',collaborator_pm:'users'}[key];
  if(collection) {
    if(typeof value==='string'&&value.startsWith('$')) {const linked=operations.find(op=>op.ref===value.slice(1));if(linked)return `<span>${esc(linked.data.name||linked.data.username||'本批关联记录')}（本批）</span>`;}
    const linked=S[collection]?.find(row=>row.id===Number(value));if(linked)return `<span>${esc(linked.name)}</span>`;
  }
  if(key==='collaborators'&&Array.isArray(value))return `<span>${value.map(id=>esc(S.users.find(u=>u.id===Number(id))?.name||id)).join('、')}</span>`;
  if(key==='kind'&&['personal','management'].includes(value))return `<span>${value==='personal'?'个人提成':'管理提成'}</span>`;
  if(Array.isArray(value)) {
    return `<ul>${value.map(v=>`<li>${v&&typeof v==='object'?Object.entries(v).map(([k,x])=>`${esc((key==='items'?itemLabels[k]:null)||intakeFieldLabel(type,k))}：${esc(x)}`).join(' · '):esc(v)}</li>`).join('')}</ul>`;
  }
  if(value&&typeof value==='object')return `<pre>${esc(JSON.stringify(value,null,2))}</pre>`;
  return `<span>${esc(value===true?'是':value===false?'否':value??'缺失')}</span>`;
}
export function intake(S,P) {
  const batch=P.batch;
  const history=importHistory(S,batch?.id);
  const upload=`<section class="panel ai-receiver">${sectionHead('上传资料','',badge(S.ai.configured?'AI 已连接':'AI 未配置',S.ai.configured?'success':'warning'))}<form data-form="ai-intake" data-key="${crypto.randomUUID()}"><div class="ai-upload-area"><input class="ai-file-input" name="files" type="file" multiple tabindex="-1" aria-label="添加资料文件" accept=".pdf,.xlsx,.md,.markdown,.txt,.csv,.json,.docx,.png,.jpg,.jpeg,.webp"><button type="button" class="ai-dropzone" data-action="ai-pick-files"><span class="ai-drop-art" aria-hidden="true"><i class="ai-paper ai-paper-back"></i><i class="ai-paper ai-paper-front">${icon('note')}</i><span class="ai-paper-plus">${icon('plus')}</span></span><strong>把资料拖到这里</strong><span class="ai-drop-sub">也可<span class="ai-upload-link">点击上传</span>，或粘贴文件</span></button><ul class="ai-file-list" data-ai-file-list aria-label="待识别文件"></ul><div class="ai-upload-caption"><span data-ai-file-status role="status" aria-live="polite"></span><span>最多 5 个 · 单个 10 MB · 合计 20 MB</span></div></div>${P.previousBatch?`<input type="hidden" name="previous_batch_id" value="${P.previousBatch}"><p class="ai-context">补充批次 #${P.previousBatch} · 保留原附件</p>`:''}<label class="field">${P.previousBatch?'补充信息':'补充说明（可选）'}<textarea name="text" rows="3" placeholder="如需修改已有记录，请写明对象和要改的内容。"></textarea></label><p class="form-error" role="alert"></p><div class="ai-form-footer"><span>${icon('shield')}核对后入库</span><button type="submit" class="btn primary">${icon('note')}识别资料</button></div></form></section>`;
  let preview='';
  if(batch) preview=`<section class="panel ai-preview">${sectionHead(`批次 #${batch.id} · ${batch.state==='confirmed'?'已入库':batch.state==='cancelled'?'已取消':'待核对'}`,batch.summary)}${batchTimeline(batch)}${destinationReceipt(S,batch)}${batch.files.map(f=>`<p class="panel-copy">${icon('note')}${esc(f.filename)} · ${Math.ceil(f.bytes/1024)}KB ${button('下载原文件','ai-file',f.id,'ghost','download')}</p>`).join('')}${batch.errors.length?`<div class="ai-errors" role="alert"><h3>校验未通过，整批禁止入库</h3><ul>${batch.errors.map(e=>`<li><b>${esc(e.source_file||'本批资料')} · ${esc(e.record||'记录')}</b>：${esc(e.message)}</li>`).join('')}</ul><p>请补充缺失信息后重新识别。</p></div>`:''}${batch.questions.some(q=>!batch.errors.some(e=>e.message===q))?`<div class="notice spaced"><div><b>待核对</b>${batch.questions.filter(q=>!batch.errors.some(e=>e.message===q)).map(q=>`<p>${esc(q)}</p>`).join('')}</div></div>`:''}${batch.state==='confirmed'?'<details class="ai-original-preview"><summary>查看原提案</summary>':''}<div class="ai-operations">${batch.operations.map((op,index)=>`<article class="ai-operation"><h3>${index+1}. ${esc(intakeTypes[op.type]||op.type)} · ${op.action==='update'?'修改 #'+esc(op.target_id):'新增 / 登记'} </h3><p class="ai-planned">${batch.state==='confirmed'?'已核对资料':'预计写入：'+esc(intakeDestinations[op.type]?.label||intakeTypes[op.type]||op.type)+''}</p><dl>${previewFields(op).map(k=>`<div><dt>${esc(intakeFieldLabel(op.type,k))}</dt><dd>${op.data[k]===undefined||op.data[k]===''?'<span class="ai-field-missing">未提供</span>':valueView(op.data[k],k,S,batch.operations,op.type)}</dd></div>`).join('')}</dl>${op.calculation?`<p class="ai-calculation">${calculationSummary(op.calculation)}</p>`:''}${op.evidence?`<details><summary>原文依据</summary><p>${esc(op.source_file)}：${esc(op.evidence)}</p></details>`:''}</article>`).join('')}</div>${batch.state==='confirmed'?'</details>':''}${batch.state==='draft'?`<div class="ai-review-actions">${button('补充资料','ai-supplement',batch.id,'secondary','note')}${button('重新校验','ai-validate',batch.id,'secondary','refresh')}${button('取消本批','ai-cancel',batch.id,'ghost','close')}</div><form data-form="ai-confirm" data-id="${batch.id}" data-version="${batch.version}" data-key="${crypto.randomUUID()}"><label class="ai-confirm-check"><input type="checkbox" name="acknowledged" required ${batch.errors.length?'disabled':''}>已核对记录、关联关系与金额，同意入库。</label><p class="form-error" role="alert"></p><button type="submit" class="btn primary" ${batch.errors.length||!batch.operations.length?'disabled':''}>确认整批入库</button></form>`:batch.state==='confirmed'?'':'<p class="panel-copy">本批未入库。</p>'}</section>`;
  return upload+preview+history+fixedFieldGuide(S,P);
}
function previewFields(op) {
  const def=intakeSchema[op.type];if(!def)return Object.keys(op.data);
  const required=op.action==='update'&&def.table?[]:def.required;
  return operationFields(op.type,op.action).filter(key=>key in op.data||required.includes(key));
}
function fixedFieldGuide(S,P) {
  const groups=visibleGuideGroups(S.actor.role);
  const selected=groups.find(group=>group.id===P.guideTable)||groups[0];
  const filter=`<label class="ai-field-filter" for="ai-guide-table">业务表<select id="ai-guide-table" aria-controls="ai-guide-fields">${groups.map(group=>`<option value="${esc(group.id)}"${group.id===selected?.id?' selected':''}>${esc(group.title)}</option>`).join('')}</select></label>`;
  return `<section class="panel ai-field-list">${sectionHead('业务字段','新增按必填项校验；修改只检查改动，历史缺值保留。',filter)}<p class="ai-field-note">* 仅新建时填写。金额按元填写，库内金额以整数分保存；→ 表示 JSON 路径。季度目标、绩效手动设置。</p><div class="ai-business-grid" id="ai-guide-fields">${intakeGuideCard(S,selected?.id)}</div></section>`;
}
export function intakeGuideCard(S,groupId) {
  const groups=visibleGuideGroups(S.actor.role),group=groups.find(group=>group.id===groupId)||groups[0];
  if(!group)return '';
    const history=(S.ai.importHistory||[]).filter(record=>group.types.includes(record.type)).sort((a,b)=>Date.parse(b.imported_at)-Date.parse(a.imported_at));
    const entries=new Map(),notes=[];
    for(const [index,type] of group.types.entries()) {
      const fields=guideFields(type,S.actor.role),definition=intakeSchema[type];
      const primary=index===0,conditional=fields.conditional.flat();
      for(const key of [...new Set([...fields.required,...conditional,...fields.optional,...fields.update])]) {
        const mapping=guideMapping(S,type,key);
        const isRequired=fields.required.includes(key),isConditional=conditional.includes(key),updateOnly=fields.action==='update'||!fields.required.includes(key)&&!conditional.includes(key)&&!fields.optional.includes(key);
        const existing=entries.get(key),entry=existing||{key,type,mappings:[],requirement:updateOnly?'仅修改':primary?(isRequired?'必填':isConditional?'条件必填':'选填'):'选填',createOnly:primary&&fields.update.length>0&&!fields.update.includes(key)&&!updateOnly,notes:[]};
        if(mapping&&!entry.mappings.includes(mapping))entry.mappings.push(mapping);
        if(!primary&&isRequired){if(entry.requirement==='选填')entry.requirement='条件必填';entry.notes.push(intakeTypes[type]+'时必填');}
        const condition=guideCondition(type,key);
        if(condition){entry.requirement='条件必填';entry.notes.push(condition);}
        if(mapping?.kind==='control'||['confirmed','both_stamped'].includes(key))entry.requirement='操作确认';
        entries.set(key,entry);
      }
      for(const keys of fields.conditional)notes.push(keys.map(key=>intakeFieldLabel(type,key)).join('、')+'至少提供一项。');
      const note=guideNote(type,fields.action);if(note)notes.push(note);
      if(definition.itemsSchema)notes.push(`${definition.itemsSchema.label}每批 ${definition.itemsSchema.minimum}–${definition.itemsSchema.maximum} 条；明细要求列在下方。`);
    }
    const locations=group.locations.map(location=>location.label).join('；');
    const latest=history[0]?.imported_at;
    return `<article class="ai-business-card" data-guide="${group.id}"><header><div><h3>${esc(group.title)}</h3><code>${esc(group.table)}</code>${group.storageKey?`<small>${esc(group.storageKey)}</small>`:''}</div>${group.types.every(type=>intakeSchema[type].adminOnly)?'<span class="ai-card-role">管理者</span>':''}</header><div class="ai-business-meta"><span title="${esc(locations)}">${esc(locations)}</span><span class="ai-business-date">最近入库 ${latest?`<time>${dateTime(latest)}</time>`:'<span>暂无</span>'}</span></div><table class="ai-column-table"><thead><tr><th>字段</th><th>要求</th><th>数据库列</th></tr></thead><tbody>${[...entries.values()].map(entry=>guideFieldRow(S,group,entry)).join('')}</tbody></table>${notes.length?`<div class="ai-card-notes">${[...new Set(notes)].map(note=>`<p>${esc(note)}</p>`).join('')}</div>`:''}</article>`;
}
function guideCondition(type,key) {
  return {
    customer:{reason:'更换负责人时必填'},
    opportunity:{reason:'更换销售负责人时必填',lost_reason:'改为输单时必填'},
    contract:{owner_id:'无可继承负责人时必填；否则沿用关联商机或客户的负责人',reason:'更换负责人时必填'},
    contract_item:{reason:'调整毛利或产品/服务分类时必填'},
    payment:{pay_date:'已到账时必填',promise_date:'待到账或逾期计划必填'},
    document_template:{quote:'报价、合同正文至少提供一份',contract:'报价、合同正文至少提供一份'},
    contract_attachment:{contract_id:'须明确已有合同编号，或本批新建合同引用'},
    contract_archive:{contract_id:'须明确已有合同编号，或本批新建合同引用'},
  }[type]?.[key]||'';
}
function guideNote(type,action) {
  if(type==='contract'&&action==='update')return '项目经理仅维护关联项目的交付范围、项目状态、研发交付人员和项目备注。';
  return {opportunity:'商机编号由系统生成。同一客户可有多条商机；项目/服务金额由合同总额减 cash 金额计算。',quote:'报价明细存于 quotes.items 的 JSON 数组，折后总额由系统计算写入 quotes.amount。',contract:'新合同保存后即按已签署登记，可直接安排收款计划和登记实际到账，签章附件可后补。合同金额由明细合计，毛利按明细汇总；历史缺值保留待核对。',contract_attachment:'关联已有或本批新建合同，附件可后补，不影响合同签署登记。',contract_archive:'历史草稿确认签署须明确对应合同，并确认已签署；签章附件选填。',contract_item:'修改已有明细；调整毛利或产品/服务分类须说明原因。毛利金额与毛利率同时提供时，计算结果须一致。分类可改为标品、交付、定开、运维；历史实施分类可保留。',payment:'每笔款项状态为待到账、已到账或逾期。已到账须实际到账日；收款计划须填写预计收款日。合同整体回款状态（未回款/部分回款/已结清）、已回及未回金额由实际到账流水汇总；产品/服务金额、毛利和销售等展示字段来自关联合同或已核实的历史来源，不重复填入 payments。',payment_receive:'确认到账须明确已有收款计划。',payment_checkpoint:'催办检查点须明确已有收款计划。',document_template:'报价或合同正文至少一份。',document_template_approve:'两份模板已保存后，由管理者明确批准。',member:'绑定钉钉须提供已核验的 userId 与 unionId。',commission_pay:'发放须明确已有结算批次。'}[type]||'';
}
function guideMapping(S,type,key,nested=false) {
  const table=intakeDestinations[type]?.table,catalog=S.ai.businessTables;
  if(catalog)return catalog[table]?.inputs?.[type]?.[nested?'items':'fields']?.[key]||{kind:'invalid',valid:false,targets:[]};
  return (nested?intakeItemStorage:intakeStorage)[type]?.[key];
}
function guideFieldRow(S,group,entry) {
  const targets=[...new Map(entry.mappings.flatMap(mapping=>mapping.targets||[]).map(target=>[JSON.stringify(target),target])).values()];
  const primary=targets.find(target=>target.table===group.table&&target.column===entry.key)||targets.find(target=>target.table===group.table)||targets[0];
  const location=target=>storageTargetLabel(target,group.table);
  const nested=entry.key==='items'&&entry.type==='contract';
  const invalid=entry.mappings.some(mapping=>mapping.valid===false);
  const column=invalid?'字段待核对':nested?'contract_items':primary?location(primary):'仅操作确认';
  const others=targets.filter(target=>nested||target!==primary);
  const extra=others.length?`<details class="ai-column-targets"><summary aria-label="其他写入位置">+${others.length}</summary><ul>${others.map(target=>`<li><code>${esc(location(target))}</code></li>`).join('')}</ul></details>`:'';
  const requirementClass={'必填':'required','条件必填':'conditional','选填':'optional','仅修改':'update','操作确认':'confirmation'}[entry.requirement];
  const notes=[...new Set([...entry.notes,...entry.mappings.filter(mapping=>mapping.purpose).map(mapping=>mapping.purpose)])];
  const row=`<tr data-field="${esc(entry.key)}"><td><span class="ai-column-name">${esc(intakeFieldLabel(entry.type,entry.key))}${entry.createOnly?'<sup class="ai-create-only" title="仅新建时填写" aria-label="仅新建时填写">*</sup>':''}</span>${notes.length?`<small class="ai-column-note">${notes.map(note=>esc(note)).join('；')}</small>`:''}</td><td><span class="ai-field-requirement ${requirementClass}">${esc(entry.requirement)}</span></td><td><div class="ai-column-destination"><code>${esc(column)}</code>${extra}</div></td></tr>`;
  return row+(entry.key==='items'?itemFields(S,entry.type,group.table):'');
}
function itemFields(S,type,table) {
  const definition=intakeSchema[type]?.itemsSchema;if(!definition)return '';
  return definition.fields.map(key=>{
    const mapping=guideMapping(S,type,key,true),target=mapping?.targets?.[0],column=mapping?.valid===false?'字段待核对':target?storageTargetLabel(target,table):'字段待核对';
    const required=definition.required.includes(key);
    const note=mapping?.purpose||(key==='kind'?'标品 / 实施 / 定开 / 交付 / 运维':key==='discount_rate'?'0–1；未填按原价':key==='quantity'?'大于零，可按人天填写':'');
    return `<tr class="ai-item-row" data-item-field="${esc(key)}"><td><span class="ai-column-name">${esc(itemLabels[key]||labels[key]||key)}</span>${note?`<small class="ai-column-note">${esc(note)}</small>`:''}</td><td><span class="ai-field-requirement ${required?'required':'optional'}">${required?'明细必填':'明细选填'}</span></td><td><code>${esc(column)}</code></td></tr>`;
  }).join('');
}
const dateTime=value=>value&&Number.isFinite(Date.parse(value))?esc(new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})):'未记录';
function batchTimeline(batch) {
  return `<dl class="ai-batch-timeline"><div><dt>接收时间</dt><dd>${dateTime(batch.created_at)}</dd></div><div><dt>实际入库时间</dt><dd>${batch.state==='confirmed'?dateTime(batch.confirmed_at):'尚未入库'}</dd></div></dl>`;
}
function destinationLink(record,S,seen) {
  const collection={customer:'customers',opportunity:'opportunities',contract:'contracts'}[record.detail_action];
  const canOpen=collection&&S[collection]?.some(r=>r.id===Number(record.detail_id));
  const legacyViews={document_template:'contracts',document_template_approve:'contracts',member:'team',ppl_config:'intake',ppl_snapshot:'intake',change_request:'intake',change_request_review:'intake'};
  const view=record.view==='settings'?(record.type==='rules'?(record.section==='finance_rules'?'commissions':'opportunities'):legacyViews[record.type]||'intake'):record.view;
  const adminOnly=['team'].includes(view);
  if(adminOnly&&S.actor.role!=='admin')return '';
  const target=[view,canOpen?record.detail_action:'',canOpen?record.detail_id:''].join(':');
  if(seen.has(target))return '';seen.add(target);
  return `<button class="text-link" data-action="ai-destination" data-view="${esc(view||'intake')}" ${canOpen?`data-detail="${esc(record.detail_action)}" data-record="${record.detail_id}"`:''}>${canOpen?'查看记录':'打开模块'} ${icon('arrow')}</button>`;
}
function destinationReceipt(S,batch) {
  if(batch.state!=='confirmed')return '';
  const records=batch.records||[];
  const seen=new Set();
  return `<section class="ai-import-receipt"><header><div><h3>${icon('check')}入库去向</h3></div><b>${records.length} 条记录</b></header>${records.length?`<div class="ai-receipt-records">${records.map(record=>`<article class="ai-receipt-record"><div><span class="ai-receipt-module">${esc(record.module_label||record.label)}</span><h4>${esc(record.record_label)}</h4><p>${esc(record.action==='update'?'更新':'新增 / 登记')} · 来源：${esc(record.source_file)}</p>${record.related_records?.length?`<details><summary>包含 ${record.related_records.length} 条合同明细</summary><ul>${record.related_records.map(r=>`<li>${esc(r.record_label)} · #${r.record_id}</li>`).join('')}</ul></details>`:''}<small>${S.actor.role==='admin'?`${esc(record.table)} · `:''}${record.record_id?'记录 #'+record.record_id:record.record_key?'记录键 '+esc(record.record_key):'历史批次未保存具体记录键'}</small></div><div class="ai-receipt-record-action"><time>${dateTime(record.imported_at)}</time>${destinationLink(record,S,seen)}</div></article>`).join('')}</div>`:'<p>历史批次无逐条回执，请查看原提案。</p>'}</section>`;
}
function importHistory(S,currentBatch) {
  const row=b=>`<article class="ai-history-entry"><header><div><h3>${esc(b.files?.join('、')||'粘贴内容 / 补充说明')}</h3><p>${esc(b.summary.length>180?b.summary.slice(0,180)+'…':b.summary)}</p></div>${badge(b.state==='confirmed'?'已入库':b.state==='cancelled'?'已取消':b.errors.length?'待补充':'待确认',b.state==='confirmed'?'success':b.errors.length?'warning':'blue')}</header><div class="ai-history-destinations"><span>${b.state==='confirmed'?'实际导入到':b.state==='cancelled'?'未入库':'识别去向（未写入）'}</span>${b.state==='confirmed'?(b.destinations?.map(d=>`<b>${esc(d.label)} ${d.count} 条</b>`).join('')||'<b>历史批次未记录去向</b>'):b.state==='cancelled'?'':b.planned_destinations?.map(d=>`<b>${esc(d)}</b>`).join('')||'<b>待补充资料</b>'}</div><footer><div><span>接收 ${dateTime(b.created_at)}</span><span>入库 ${b.state==='confirmed'?dateTime(b.confirmed_at):'尚未入库'}</span></div>${b.id===currentBatch?'<span class="muted">当前批次</span>':button('查看批次','ai-batch',b.id,'ghost','chevron')}</footer></article>`;
  const batches=S.ai.batches;
  return `<section class="panel ai-history">${sectionHead('接收记录','')}<div class="ai-history-list">${batches.slice(0,10).map(row).join('')||'<p class="ai-history-empty">还没有接收记录</p>'}</div>${batches.length>10?`<details class="ai-history-more"><summary>查看其余 ${batches.length-10} 条记录</summary><div class="ai-history-list">${batches.slice(10).map(row).join('')}</div></details>`:''}</section>`;
}

function calculationSummary(c) {
  if(c.components)return c.components.map(x=>`${esc(x.label)}：${esc(x.basis)} ¥${x.base.toLocaleString('zh-CN')}，应计 ¥${x.total.toLocaleString('zh-CN')}`).join('；')+`。本次结算 ¥${c.due.toLocaleString('zh-CN')}。`;
  return `系统试算：累计毛利 ¥${c.base.toLocaleString('zh-CN')} × ${(c.rate*100).toFixed(0)}%，本次结算 ¥${c.due.toLocaleString('zh-CN')}。`;
}
