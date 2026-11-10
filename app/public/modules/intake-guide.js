import {intakeSchema,intakeDestinations,fieldNames,operationFields,allowedIntakeActions} from './intake-schema.js';

export const intakeGuideGroups=Object.freeze([
  {id:'customers',title:'客户',types:['customer'],locations:[{label:'客户档案',view:'customers'}]},
  {id:'contacts',title:'联系人',types:['contact'],locations:[{label:'客户档案 → 客户详情 → 联系人与决策链',view:'customers'}]},
  {id:'opportunities',title:'商机',types:['opportunity'],locations:[{label:'商机推进',view:'opportunities'}]},
  {id:'activities',title:'跟进与会议',types:['activity'],locations:[
    {label:'跟进记录',view:'activities'},
    {label:'商机推进 → 商机详情 → 跟进时间线',view:'opportunities'},
  ]},
  {id:'quotes',title:'报价',types:['quote'],locations:[{label:'商机推进 → 商机详情 → 报价记录',view:'opportunities'}]},
  {id:'contracts',title:'合同订单',types:['contract','contract_archive'],locations:[{label:'合同订单 → 合同详情',view:'contracts'}]},
  {id:'contract-items',title:'合同明细',types:['contract_item'],locations:[{label:'合同订单 → 合同详情 → 合同行项',view:'contracts'}]},
  {id:'attachments',title:'合同附件',types:['contract_attachment'],locations:[{label:'合同订单 → 合同列表 → 合同附件',view:'contracts'}]},
  {id:'payments',title:'回款管理',types:['payment','payment_receive','payment_allocation','payment_checkpoint'],locations:[
    {label:'回款管理 → 回款明细 → 回款记录与计划',view:'collections'},
  ]},
  {id:'templates',title:'公司模板',types:['document_template','document_template_approve'],storageKey:'integrations.documents',locations:[{label:'合同订单 → 维护公司模板',view:'contracts'}]},
  {id:'commissions',title:'提成',types:['commission_confirm','commission_pay'],advanced:true,locations:[{label:'提成结算',view:'commissions'}]},
  {id:'rules',title:'业务规则',types:['rules'],storageKey:'rules',advanced:true,locations:[
    {scope:'阶段停滞阈值、阶段动作规范',label:'商机推进 → 维护阶段规则',view:'opportunities'},
    {scope:'提成规则',label:'提成结算',view:'commissions'},
    {scope:'绩效规则',label:'绩效评定',view:'performance'},
  ]},
]);
const names={source_file:{contract_archive:'签章附件（选填）',contract_attachment:'合同附件'},both_stamped:{contract_archive:'确认已签署'},product_amount:{payment:'本笔产品回款金额（元）',payment_receive:'本笔产品回款金额（元）',payment_allocation:'本笔产品回款金额（元）'},name:{customer:'客户全称',contact:'联系人姓名',opportunity:'售卖产品',contract:'合同名称',contract_item:'产品/服务名称',member:'成员姓名'},kind:{contract_item:'产品/服务类型'},collaborator_pm:{contract:'项目经理',opportunity:'协作项目经理'},role:{contact:'联系人角色',member:'成员角色'},owner_id:{opportunity:'销售姓名',contract:'销售小二'},amount:{opportunity:'合同总额（元）',payment:'本笔回款或计划金额（元）'},status:{payment:'本笔款项状态'},valid_until:{contract:'产品到期日',contract_item:'产品到期日'}};
export function intakeFieldLabel(type,key) {
  return names[key]?.[type]||({customer_id:'客户全称或编号',opportunity_id:'商机编号或售卖产品',contract_id:'合同名称或编号',owner_id:'负责人姓名',user_id:'销售姓名',sales_id:'销售姓名',items:intakeSchema[type]?.itemsSchema?.label||'明细',source_file:'原始附件'}[key])||fieldNames[key]||key;
}
export function visibleGuideGroups(role) {
  return intakeGuideGroups.map(g=>{
    const types=g.types.filter(t=>allowedIntakeActions(t,role).length);
    return {...g,table:intakeDestinations[types[0]]?.table,types,locations:g.locations.filter(location=>!location.types||location.types.some(t=>types.includes(t)))};
  }).filter(g=>g.types.length);
}
export function guideFields(type,role='admin') {
  const def=intakeSchema[type],actions=allowedIntakeActions(type,role),action=actions.includes('create')?'create':'update';
  const fields=operationFields(type,action,role),required=action==='update'&&def.table?[]:def.required.filter(k=>fields.includes(k));
  const conditional=action==='create'?(def.requiredAny||[]).filter(group=>group.every(k=>fields.includes(k))):[];
  return {action,required,conditional,optional:fields.filter(k=>!required.includes(k)&&!conditional.flat().includes(k)),update:def.table&&actions.includes('create')&&actions.includes('update')?operationFields(type,'update',role):[]};
}
