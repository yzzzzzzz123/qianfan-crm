import {canManageContract} from './contract-access.js';
import {esc,plainMoney,dateLabel,salesName,customerName,userName,actionButton as button} from '../ui.js';

const amount=v=>v==null?'待补充':plainMoney(v);
const show=v=>esc(v||'待补充');
const timestamp=v=>v?esc(new Date(v).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false}).replaceAll('-','.')):'待补充';
const names=c=>(c.product_names||c.items?.map(i=>i.name)||[]).join('、');
const kinds=c=>(c.product_types||[...new Set((c.items||[]).map(i=>i.kind))]).join('、');
const margin=(S,v)=>S.actor.role==='pm'?'权限受限':amount(v);
export const files=(S,c)=>S.actor.role==='pm'||c.can_download_attachments===false?'权限受限':(c.attachments||[]).map(f=>button(f.filename,'record-attachment',f.id,'ghost')).join('')||'未上传';

// The list, detail and maintenance overview render the same field definitions.
export function contractFields(S,c){return [
 ['客户名称 / 合同',`${show(customerName(S,c.customer_id))}<span class="record-meta">${show(c.contract_no||c.code)} · ${show(c.name)}</span>`],
 ['订单类型',show(c.order_type)],['售卖产品',show(names(c))],['产品类型',show(kinds(c))],['产品续费标签',show(c.renewal_tag)],
 ['合同签订时间',dateLabel(c.sign_date)],['回款时间',dateLabel(c.last_received_at)],['合同金额',amount(c.amount)],
 ['产品金额',amount(c.product_amount)],['产品毛利率',S.actor.role==='pm'?'权限受限':c.product_margin_rate==null?'待补充':`${(c.product_margin_rate*100).toLocaleString('zh-CN',{maximumFractionDigits:12})}%`],
 ['产品毛利',margin(S,c.product_margin)],['项目／服务金额',amount(c.service_amount)],['项目／服务毛利',margin(S,c.service_margin)],['总毛利',margin(S,c.total_margin)],
 ['付款类型',show(c.payment_type)],['回款状态',show(c.collection_status||(c.collected<=0?'未回款':c.outstanding>0?'部分回款':'已结清'))],
 ['已回款金额',amount(c.collected)],['产品到期时间',dateLabel(c.valid_until)],['销售小二',show(salesName(S,c))],['合同附件',files(S,c)],['创建时间',timestamp(c.created_at)],
];}
export function collectionFields(S,c){return [
 ['关联合同 / 客户名称',`${show(c.contract_no||c.code)}<span class="record-meta">${show(customerName(S,c.customer_id))} · ${show(c.name)}</span>`],
 ['项目状态',show(c.project_status)],['产品',show(names(c))],['预计回款时间',dateLabel(c.next_expected_at)],['实际回款时间',dateLabel(c.last_received_at)],
 ['合同金额',amount(c.amount)],['产品毛利',margin(S,c.product_margin)],['服务毛利',margin(S,c.service_margin)],['总毛利',margin(S,c.total_margin)],
 ['是否已回款',show(c.received_status||'否')],['已回款金额',amount(c.collected)],['未回款金额',amount(c.outstanding)],
 ['销售小二',show(c.collection_sales_names?.length?c.collection_sales_names.join('、'):salesName(S,c))],
 ['项目经理',show(c.collection_manager_names?.length?c.collection_manager_names.join('、'):c.collaborator_pm?userName(S,c.collaborator_pm):null)],
 ['研发交付人员',show(c.delivery_staff)],['创建时间',timestamp(c.collection_source_count?c.collection_created_at:c.created_at)],['备注',show(c.project_note)],
];}
export const fieldFacts=rows=>`<dl class="detail-facts aligned-facts">${rows.map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
export const canDeleteContract=(S,c)=>!c.read_only&&!c.retired_at&&canManageContract(S,c);
