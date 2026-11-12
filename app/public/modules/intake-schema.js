// Fixed CRM intake contract. Changes require a reviewed application update.
const schema={
  customer:{path:'/customers',table:'customers',required:['name','owner_id'],fields:'name short_name industry region manual_level owner_id status credit_code scale note parent_company group_name tags compliance_flag reason duplicate_ack collaborators'},
  contact:{path:'/contacts',table:'contacts',required:['customer_id','name'],fields:'customer_id name title phone role attitude wechat dingtalk last_contact note active'},
  opportunity:{path:'/opportunities',table:'opportunities',required:['customer_id','name','owner_id','stage','amount','product_amount','sale_type','order_type'],fields:'customer_id name owner_id stage amount product_amount sale_type order_type next_action follow_date expected_date lost_reason reason collaborator_pm'},
  activity:{path:'/activities',required:['opportunity_id','summary','activity_type','activity_date'],fields:'opportunity_id summary action activity_type source activity_date follow_date'},
  quote:{path:'/quotes',required:['opportunity_id','items'],fields:'opportunity_id items valid_until note'},
  contract:{path:'/contracts',table:'contracts',required:['name','sign_date','items'],fields:'opportunity_id customer_id name owner_id sign_date valid_until contract_no scope additional items sale_type order_type renewal_tag payment_type project_status collaborator_pm delivery_staff project_note reason'},
  contract_attachment:{path:'/contracts',suffix:'/attachments',required:['source_file'],fields:'contract_id source_file'},
  contract_archive:{path:'/contracts',suffix:'/archive',required:['both_stamped'],fields:'contract_id source_file both_stamped'},
  contract_item:{path:'/items',table:'contract_items',required:[],fields:'name kind payment_date valid_until margin margin_rate man_days reason'},
  payment:{path:'/payments',required:['contract_id','amount','status'],fields:'contract_id amount product_amount status pay_date promise_date checkpoint_date note'},
  payment_receive:{path:'/payments',suffix:'/receive',required:['pay_date'],fields:'pay_date product_amount'},
  payment_allocation:{path:'/payments',suffix:'/allocation',required:['product_amount','reason'],fields:'product_amount reason'},
  payment_checkpoint:{path:'/payments',suffix:'/checkpoint',required:['checkpoint_date','reason'],fields:'checkpoint_date reason'},
  document_template:{adminOnly:true,path:'/integrations/config',required:['issuer'],fields:'issuer quote contract'},
  document_template_approve:{adminOnly:true,path:'/integrations/config',required:['confirmed'],fields:'confirmed'},
  rules:{adminOnly:true,path:'/rules',required:[],fields:'thresholds sop commission performance customer_levels'},
  member:{adminOnly:true,path:'/users',table:'users',required:['name','username','role'],fields:'name username role ding_user_id ding_union_id active performance_enabled'},
};
Object.assign(schema.customer,{createFields:schema.customer.fields.split(' ').filter(k=>!['status','reason','collaborators'].includes(k)),updateFields:schema.customer.fields.split(' ').filter(k=>k!=='duplicate_ack')});
Object.assign(schema.contact,{createFields:schema.contact.fields.split(' ').filter(k=>k!=='active'),updateFields:schema.contact.fields.split(' ').filter(k=>k!=='customer_id')});
Object.assign(schema.opportunity,{createFields:schema.opportunity.fields.split(' ').filter(k=>!['lost_reason','reason'].includes(k)),updateFields:schema.opportunity.fields.split(' ')});
Object.assign(schema.contract,{createFields:schema.contract.fields.split(' ').filter(k=>k!=='reason'),updateFields:['name','sign_date','contract_no','scope','valid_until','owner_id','reason','sale_type','order_type','renewal_tag','payment_type','project_status','collaborator_pm','delivery_staff','project_note']});
Object.assign(schema.member,{createFields:schema.member.fields.split(' ').filter(k=>!['active','performance_enabled'].includes(k)),updateFields:schema.member.fields.split(' ')});
schema.document_template.updateRequired=[];
schema.contact.requiredAny=[['phone','wechat','dingtalk']];
schema.contract.requiredAny=[['opportunity_id','customer_id']];
schema.quote.itemsSchema={label:'报价明细',fields:['name','kind','quantity','list_price','discount_rate'],required:['name','kind','quantity','list_price'],minimum:1,maximum:100};
schema.contract.itemsSchema={label:'合同明细',fields:['name','kind','amount','margin','margin_rate','margin_before_expense','business_expense','man_days','payment_date','valid_until'],required:['name','kind','amount'],minimum:1,maximum:30};

// Permissions describe the same actions that the service accepts; stored fields remain fixed.
for(const [type,def] of Object.entries(schema)) {
  const business=['admin','sales'];
  def.actionRoles=def.adminOnly?{create:['admin'],update:def.table||def.suffix||['ppl_config','document_template','document_template_approve','rules','commission_confirm'].includes(type)?['admin']:[]}:
    type==='activity'?{create:['admin','sales','pm'],update:[]}:
    type==='contract'?{create:business,update:[...business,'pm']}:
    {create:business,update:def.table||def.suffix?business:[]};
  if(type==='contract_item')def.actionRoles.create=[];
  if(type==='contract')def.roleFields={pm:{update:['scope','project_status','delivery_staff','project_note']}};
}

// Physical destinations of accepted fields. Controls and derived inputs are explicit,
// so a future field cannot be advertised without a reviewed persistence contract.
const column=(table,name,extra={})=>({table,column:name,...extra});
const stored=(...targets)=>({kind:'stored',targets});
const control=purpose=>({kind:'control',purpose});
const derived=(purpose,...targets)=>({kind:'derived',purpose,targets});
const direct=(type,table)=>Object.fromEntries(schema[type].fields.split(' ').map(name=>[name,stored(column(table,name))]));
const auditReason=stored(column('audit','detail',{jsonPath:'reason'}));
const setting=(key,path)=>stored(column('settings','value',{key,jsonPath:path}));
const storage={
  customer:{...direct('customer','customers'),reason:auditReason,duplicate_ack:control('仅确认经核对为不同企业的同名客户，不作为客户属性'),collaborators:stored(column('customer_collaborators','user_id'))},
  contact:{...direct('contact','contacts'),active:derived('启用或停用映射为归档时间',column('contacts','archived_at'))},
  opportunity:{...direct('opportunity','opportunities'),reason:auditReason},
  activity:{...direct('activity','activities'),opportunity_id:stored(column('activities','opportunity_id'),column('activity_events','opportunity_id')),activity_date:stored(column('activities','activity_date'),column('activity_events','activity_date')),action:derived('非空后续行动同时更新商机下一步动作；空白不清除既有行动',column('activities','action'),column('opportunities','next_action')),follow_date:derived('有明确日期时更新商机下次跟进日期',column('opportunities','follow_date')),source:derived('逐次来源保留在事件；同日归并记录可显示多源',column('activities','source'),column('activity_events','source')),activity_type:derived('逐次类型保留在事件；同日归并记录可显示综合跟进',column('activities','activity_type'),column('activity_events','activity_type')),summary:derived('逐次摘要保留在事件，并归并到同日跟进摘要',column('activities','summary'),column('activity_events','summary'))},
  quote:{...direct('quote','quotes'),items:derived('报价明细保存原价、数量和折扣；系统逐行计算折后总额，原价及折扣合计由明细实时计算',column('quotes','items'),column('quotes','amount'))},
  contract:{...direct('contract','contracts'),reason:auditReason,additional:control('明确是否允许已有商机追加合同'),items:derived('明细逐行存入合同行项，合同总金额由明细合计；新合同保存即按已签署登记，签章附件选填；毛利率按金额计算毛利',...schema.contract.itemsSchema.fields.filter(name=>name!=='margin_rate').map(name=>column('contract_items',name)),column('contracts','amount'),column('contracts','lifecycle'))},
  contract_attachment:{contract_id:stored(column('attachments','entity_id')),source_file:derived('附件按合同编号保存，可在合同签署登记后补充',column('attachments','content'),column('attachments','filename'))},
  contract_archive:{contract_id:control('需确认签署的已有草稿，或需补充附件的明确合同引用'),source_file:derived('选填签章附件；提供时保存原件并记录附件归档依据',column('attachments','content'),column('attachments','filename'),column('contracts','archive_attachment_id'),column('contracts','archived_at'),column('contracts','archived_by')),both_stamped:derived('确认合同已签署，无附件也可确认；关联合同金额汇总到可维护商机并转赢单，保留阶段历史和系统跟进',column('contracts','lifecycle'),column('opportunities','stage'),column('opportunities','amount'),column('opportunities','next_action'),column('opportunities','follow_date'),column('stage_history','to_stage'),column('activities','summary'),column('customers','status'))},
  contract_item:{...direct('contract_item','contract_items'),margin_rate:derived('以行项金额乘毛利率并按分舍入，实际毛利率从毛利与金额反算',column('contract_items','margin')),reason:auditReason},
  payment:direct('payment','payments'),payment_allocation:{product_amount:stored(column('payments','product_amount')),reason:auditReason},payment_receive:{product_amount:stored(column('payments','product_amount')),pay_date:derived('记录本次实际到账日并生成独立实收，核销已有收款计划，保留原计划及余款',column('payments','pay_date'),column('payments','status'))},payment_checkpoint:{...direct('payment_checkpoint','payments'),reason:stored(column('payments','note'),column('audit','detail',{jsonPath:'reason'}))},
  document_template:Object.fromEntries(schema.document_template.fields.split(' ').map(name=>[name,setting('integrations','documents.'+name)])),document_template_approve:{confirmed:setting('integrations','documents.confirmed')},
  rules:Object.fromEntries(schema.rules.fields.split(' ').map(name=>[name,setting('rules',name)])),
  member:{...direct('member','users'),role:derived('保存业务角色，并按销售角色初始化绩效参与标记；明确提供绩效标记时再按该值更新',column('users','role'),column('users','performance_enabled')),ding_union_id:derived('将已核验的unionId与当前成员ID成对关联',column('ding_identities','union_id'),column('ding_identities','user_id'))},
};

// Array members share the same persistence contract as top-level inputs. A JSON
// member is a path inside a real column; margin_rate is converted into margin.
const itemStorage={
  quote:Object.fromEntries(schema.quote.itemsSchema.fields.map(name=>[name,stored(column('quotes','items',{jsonPath:name,array:true}))])),
  contract:Object.fromEntries(schema.contract.itemsSchema.fields.map(name=>[name,name==='margin_rate'?derived('以行项金额乘毛利率并按分舍入，存入毛利金额；不另存毛利率列',column('contract_items','margin')):stored(column('contract_items',name))])),
};

function freeze(value) {if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
export const intakeSchema=freeze(schema);
export const intakeStorage=freeze(storage);
export const intakeItemStorage=freeze(itemStorage);
export function storageTargetLabel(target,primaryTable) {
  return (target.table===primaryTable?'':target.table+'.')+target.column+(target.key!==undefined?' [key='+target.key+']':'')+(target.jsonPath?' → '+(target.array?'[].':'')+target.jsonPath:'');
}
export const intakeRelations=freeze({customer_id:'customer',opportunity_id:'opportunity',contract_id:'contract',owner_id:'member',user_id:'member',sales_id:'member',collaborator_pm:'member'});
export const intakeDestinations=freeze({
  customer:{module:'customers',label:'客户档案',table:'customers',route:'customers'},contact:{module:'customers',label:'客户档案 · 联系人',table:'contacts',route:'customers'},
  opportunity:{module:'opportunities',label:'商机推进',table:'opportunities',route:'opportunities'},activity:{module:'activities',label:'跟进记录',table:'activities',route:'activities'},quote:{module:'quotes',label:'商机详情 · 报价',table:'quotes',route:'opportunities'},
  contract:{module:'contracts',label:'合同订单 · 合同',table:'contracts',route:'contracts'},contract_item:{module:'contracts',label:'合同订单 · 合同明细',table:'contract_items',route:'contracts'},
  contract_attachment:{module:'contracts',label:'合同订单 · 合同附件',table:'attachments',route:'contracts'},contract_archive:{module:'contracts',label:'合同订单 · 确认签署',table:'contracts',route:'contracts'},
  payment:{module:'payments',label:'回款管理 · 回款记录与计划',table:'payments',route:'collections'},payment_allocation:{module:'payments',label:'回款管理 · 产品回款分配',table:'payments',route:'collections'},payment_receive:{module:'payments',label:'回款管理 · 确认到账',table:'payments',route:'collections'},payment_checkpoint:{module:'payments',label:'回款管理 · 催办检查点',table:'payments',route:'collections'},
  target:{module:'targets',label:'团队目标 · 季度目标',table:'targets',route:'team'},ppl_config:{module:'ppl',label:'PPL连接',table:'settings',route:'intake'},ppl_snapshot:{module:'ppl',label:'PPL同步记录',table:'sync_runs',route:'intake'},
  document_template:{module:'templates',label:'合同订单 · 公司模板',table:'settings',route:'contracts'},document_template_approve:{module:'templates',label:'合同订单 · 公司模板',table:'settings',route:'contracts'},
  change_request:{module:'changes',label:'骨架变更',table:'change_requests',route:'intake'},change_request_review:{module:'changes',label:'骨架变更',table:'change_requests',route:'intake'},
  rules:{module:'rules',label:'业务规则',table:'settings',route:'opportunities'},member:{module:'members',label:'团队管理 · 团队成员',table:'users',route:'team'},
  commission_confirm:{module:'commissions',label:'提成结算',table:'commission_batches',route:'commissions'},commission_pay:{module:'commissions',label:'提成结算 · 发放记录',table:'commission_batches',route:'commissions'},
});
// Keep retired type labels readable in historical batches; only intakeSchema permits new writes.
export const intakeTypes=freeze({payment_allocation:"产品回款分配",contract_attachment:"合同附件",contract_archive:"确认签署","customer": "客户", "contact": "联系人", "opportunity": "商机", "activity": "跟进", "quote": "报价", "contract": "合同", "contract_item": "合同行项", "payment": "回款", "payment_receive": "确认到账", "payment_checkpoint": "催办检查点", "target": "季度目标", "ppl_config": "PPL连接", "ppl_snapshot": "PPL原始快照", "document_template": "文档模板", "document_template_approve": "批准公司模板", "change_request": "骨架变更申请", "rules": "业务规则", "member": "团队成员", "performance_review": "绩效评定", "commission_confirm": "提成结算", "commission_pay": "提成发放", "change_request_review": "骨架变更审核"});
export const fieldNames=freeze({renewal_tag:'产品续费标签',payment_type:'付款类型',project_status:'项目状态',delivery_staff:'研发交付人员',project_note:'项目备注',margin_rate:'毛利率（0至1）',manual_level:"手动客户等级",customer_levels:"客户等级选项",product_amount:"cash金额（元）",sale_type:"销售类型",order_type:"订单类型",both_stamped:"确认已签署","name": "名称", "owner_id": "负责人", "customer_id": "关联客户", "opportunity_id": "关联商机", "contract_id": "关联合同", "user_id": "销售成员", "sales_id": "提成成员", "stage": "销售阶段", "amount": "金额（元）", "product_type": "产品类型", "source": "来源", "nature": "订单性质", "next_action": "下一步动作", "follow_date": "下次跟进日期", "summary": "跟进摘要", "activity_type": "跟进类型", "activity_date": "发生日期", "valid_until": "有效期", "sign_date": "签约日期", "items": "合同行项", "status": "状态", "pay_date": "实际到账日期", "promise_date": "预计收款日", "quarter": "季度", "baseId": "PPL Base ID", "operatorUnionId": "PPL 操作人 unionId", "customerSheetId": "客户 Sheet ID", "opportunitySheetId": "商机 Sheet ID", "issuer": "签约主体", "username": "登录账号", "role": "业务角色", "month": "月份", "reason": "原因", "paid_at": "发放日期", "checkpoint_date": "检查点", "entity": "对象类型", "entity_id": "对象记录", "fields": "变更内容", "short_name": "简称", "industry": "行业", "region": "地区", "credit_code": "统一社会信用代码", "scale": "企业规模", "note": "备注", "parent_company": "母公司", "group_name": "集团名称", "tags": "标签", "compliance_flag": "合规标记", "duplicate_ack": "同名客户确认", "title": "职务", "phone": "电话", "attitude": "态度", "wechat": "微信", "dingtalk": "钉钉", "last_contact": "最近联系日期", "active": "启用状态", "deal_type": "业务类型", "products": "产品", "man_days": "人天", "est_margin": "预估毛利（元）", "expected_date": "预计到单日", "lost_reason": "流失原因", "collaborator_pm": "协作PM", "action": "后续行动", "contract_no": "合同编号", "scope": "交付范围", "additional": "额外合同", "quote_file": "报价资料", "payment_date": "计划回款日", "margin": "毛利（元）", "source_file": "原始文件", "quote": "报价模板正文", "contract": "合同模板正文", "confirmed": "明确批准", "thresholds": "阶段停滞阈值", "sop": "阶段动作规范", "commission": "提成规则", "performance": "绩效规则", "ding_user_id": "钉钉 userId", "ding_union_id": "钉钉 unionId", "performance_enabled": "参与绩效", "adjustment": "过程调整分", "kind": "提成类型", "period": "结算周期", "reviewed_status": "审核结果", "collaborators": "协作成员"});
export const intakeAliases=freeze(['customer_name','opportunity_name','contract_no','owner_name','user_name','sales_name']);
export const aliasFields=freeze({customer_name:'customer_id',opportunity_name:'opportunity_id',contract_no:'contract_id',owner_name:'owner_id',user_name:'user_id',sales_name:'sales_id'});
export function operationFields(type,action,role) {const def=intakeSchema[type];if(role!==undefined&&!def?.actionRoles[action]?.includes(role))return [];return (role!==undefined?def?.roleFields?.[role]?.[action]:null)||def?.[action+'Fields']||def?.fields.split(' ')||[];}
export function allowedIntakeActions(type,role) {return ['create','update'].filter(action=>intakeSchema[type]?.actionRoles[action]?.includes(role));}
export function roleOperationFields(type,action,role) {return operationFields(type,action,role);}
export function schemaForAI() {
  return Object.fromEntries(Object.entries(intakeSchema).map(([type,def])=>[type,{module:intakeTypes[type],fields:def.fields.split(' '),...(def.createFields?{create_fields:def.createFields,update_fields:def.updateFields}:{}),required_for_create:def.required,required_for_update:def.updateRequired||(def.table?[]:def.required),...(def.requiredAny?{required_one_of_for_create:def.requiredAny}:{}),...(def.itemsSchema?{items_schema:def.itemsSchema}:{}),action_roles:def.actionRoles,...(def.roleFields?{role_fields:def.roleFields}:{}),administrator_only:!!def.adminOnly,...(['contract_attachment','contract_archive'].includes(type)?{existing_target_or_contract_reference_required:true}:def.suffix||type==='contract_item'?{existing_record_id_required:true}:{})}]));
}
