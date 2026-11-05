import {policyMatrix} from './commission-policy.js';
import {performancePolicy} from './performance-policy.js';
import {
  esc,
  empty,
  select,
  input,
  textarea,
  formShell,
} from "../ui.js";


export function formSettings(S, type, id, options) {
  if(type==='sales-commission-policy'){
    if(S.actor.role!=='admin')return empty('无权调整提成梯度','仅管理员可以维护销售个人提成规则。');
    const p=S.rules.commission.sales_policy;
    return formShell('调整个人提成梯度','产品回款和项目服务分别设置各档起点与 D、C、B、A 级比例。',
      `<div class="wide form-context">各档起点须递增；空白比例保留为待核实。修改规则后未确认的月份会重新试算，已确认结算保留原快照。</div>`+
      input('effective_month','规则生效月份',p.effective_month,'month',true)+
      select('service_aggregation','项目服务选档范围',[['pending_contract','待确认：暂按单份合同试算'],['contract','已确认：每份合同的项目／服务金额'],['month','已确认：当月项目／服务合同金额合计']],p.service_scope_confirmed?p.service_aggregation:'pending_contract')+
      `<div class="wide">${policyMatrix(p,'product',true)}${policyMatrix(p,'service',true)}</div>`,type,id,'保存提成梯度');
  }
  if(type==='performance-rules'){
    if(S.actor.role!=='admin')return empty('无权调整绩效规则','仅管理员可以维护团队的绩效计算规则。');
    const p=performancePolicy(S.rules.performance),number=(key,label,min=0)=>input('performance:'+key,label,p[key],'number',true,`min="${min}" max="100" step="0.01"`);
    return formShell('调整绩效规则','保存后重新计算未确认月份；已确认月份保留原评分、等级和工资系数。',
      `<div class="wide form-context">月度合同目标继续按季度目标 ÷ 3 计算。调整一项权重时，另一项自动补足至 100%。</div>`+
      number('process_weight','过程权重（%）')+number('result_weight','合同额结果权重（%）')+number('cap','过程原始分上限',0.01)+
      `<p class="wide field-help">过程折算分 = 原始分 ÷ 上限 × 过程权重。降低上限后，未确认的手动过程分按新上限封顶，原设置值保留。</p>`+
      number('meeting','线上会议（分／次）')+number('visit','现场拜访（分／次）')+number('quote','对客报价（分／次）')+
      `<h3 class="wide">新增漏斗计分</h3>`+number('funnel_low','低于 9,800 元（分／条）')+number('funnel_mid','9,800–50,000 元（分／条）')+number('funnel_high','高于 50,000 元（分／条）'),type,id,'保存绩效规则');
  }
  if(type==='customer-levels')return formShell('客户等级选项','每行一个手动标签；历史标签继续保留，可维护为新的选项。',textarea('levels','可选等级',S.rules.customer_levels.join('\n'),true),type,id,'保存等级选项');
  if(type==='document-templates') {
    const d=S.integrationSettings.documents;
    return formShell('报价与合同正文模板','直接粘贴公司已确认的文本；系统替换业务字段，正文中的HTML会按普通文字输出。',input('issuer','公司签约主体',d.issuer,'text',false)+textarea('quote','报价单正文',d.quote,false)+textarea('contract','合同正文',d.contract,false)+`<p class="wide field-help">可用占位符：{{issuer}}、{{customer_name}}、{{seller_name}}、{{document_no}}、{{amount}}、{{date}}、{{valid_until}}、{{items}}、{{scope}}、{{note}}。金额为元。导出Word后可继续编辑。</p>`+select('confirmed','模板确认',[['false','暂存，仍按内部核对稿导出'],['true','已核对并批准使用以上公司模板']],String(d.confirmed)),type,id,'保存模板');
  }
  if(type==='bulk-targets') return formShell('粘贴销售季度目标','每行一位销售，金额单位为元。整批校验通过才保存；已确认绩效的季度目标不能改写。',input('quarter','季度',S.quarter)+textarea('text','姓名或账号,季度目标金额','',true)+`<p class="wide field-help">格式示例：销售账号,300000。请填写真实目标，不自动套用示例金额。</p>`,type,id,'校验并保存目标');
  if(type==='finance-rules') {
    const c=S.rules.commission;
    const pct=(key,label)=>input('commission:'+key,label,c[key]*100,'number',true,'min="0" max="100" step="0.01"');
    return formShell('团队管理提成规则','调整团队累计周期、毛利阈值和计提比例；已确认结算保留原快照。',
      select('commission:period','团队毛利累计周期',[['quarter','季度'],['month','月度'],['year','年度']],c.period)+select('commission:manager_id','团队管理提成负责人',S.users.filter(u=>u.role==='admin'&&u.active).map(u=>[u.id,u.name]),c.manager_id||S.users.find(u=>u.role==='admin')?.id)+input('commission:threshold','团队跳档毛利阈值（元）',c.threshold/100,'number')+pct('low_rate','团队低档比例（%）')+pct('high_rate','团队高档比例（%）')+select('commission:unlock_by_payment','团队计提口径',[['false','成交合同毛利'],['true','按到账比例解锁']],String(c.unlock_by_payment)),type,id,'保存业务规则');
  }
  if(type==='user-mapping') {const u=S.users.find(u=>u.id===Number(id));return formShell('配置成员身份与角色','填写已核验的企业身份。角色变更后需重新登录。',input('ding_user_id','钉钉企业 userId',u.ding_user_id||'','text',false)+input('ding_union_id','钉钉 unionId（扫码登录）',u.ding_union_id||'','text',false)+select('role','业务角色',[['sales','销售'],['admin','管理者'],['pm','协作PM']],u.role),type,id);}
  if (type === "rules")
    return formShell(
      "编辑阶段与动作",
      "规则保存后立即用于停滞提醒与阶段建议。",
      S.stages
        .map(
          (s) =>
            `<div class="rule-edit wide"><h3>${esc(s)}</h3>${S.rules.thresholds[s] ? input("threshold:" + s, "停滞阈值（天）", S.rules.thresholds[s], "number", true, 'min="1" max="90"') : ""}${textarea("sop:" + s, "阶段动作", S.rules.sop[s], true)}</div>`,
        )
        .join(""),
      type,
      id,
      "保存规则",
    );
}
