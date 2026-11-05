// Confirmed in the 2026-11-01 meeting and the user's subsequent service table.
// A null rate is deliberately unresolved; it must never become an implicit zero.
export const SALES_POLICY = {
  version: 'sales-20261101', effective_month: '2026-11', service_aggregation: 'contract', service_scope_confirmed: false,
  product: [
    { min: 0, rates: { D: 0, C: 0, B: 0, A: null } },
    { min: 2000000, rates: { D: .05, C: .08, B: .10, A: .12 } },
    { min: 4000000, rates: { D: .06, C: .10, B: .12, A: .15 } },
    { min: 8000000, rates: { D: .10, C: .15, B: .18, A: .20 } },
    { min: 16000000, rates: { D: .12, C: .18, B: .20, A: .25 } },
  ],
  service: [
    { min: 0, rates: { D: 0, C: 0, B: 0, A: 0 } },
    { min: 1000000, rates: { D: .02, C: .04, B: .05, A: .06 } },
    { min: 2000000, rates: { D: .05, C: .06, B: .08, A: .10 } },
    { min: 5000000, rates: { D: .08, C: .10, B: .12, A: .15 } },
  ],
};

export function bandFor(bands, amount) {
  return bands.findLast(b => amount >= b.min);
}

export function contractSplit(contract, items) {
  const rows = items.filter(i => i.contract_id === contract.id);
  if (!rows.length || rows.some(i => !['标品','实施','定开','交付','运维'].includes(i.kind)) || rows.reduce((s,i)=>s+i.amount,0)!==contract.amount)
    return { valid:false, reason:'合同明细分类或金额不完整，不能确定产品与服务金额', items:rows };
  const product = rows.filter(i=>i.kind==='标品').reduce((s,i)=>s+i.amount,0);
  return {valid:true,product,service:contract.amount-product,items:rows};
}

// Exact integer allocation; the final line receives rounding residue.
export function allocate(total, rows) {
  const base=rows.reduce((s,i)=>s+i.amount,0);let cumulative=0,allocated=0;
  return rows.map(i=>{cumulative+=i.amount;const amount=Math.round(total*cumulative/base)-allocated;allocated+=amount;return {...i,base:amount};});
}

export function validateSalesPolicy(value, assert) {
  assert(value && typeof value==='object' && !Array.isArray(value),'销售提成规则无效');
  assert(Object.keys(value).every(k=>['version','effective_month','service_aggregation','service_scope_confirmed','product','service'].includes(k)),'销售提成规则包含未知字段');
  assert(value.version===SALES_POLICY.version,'销售提成规则版本不可修改');
  assert(typeof value.effective_month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value.effective_month),'请选择有效的规则生效月份');
  assert(['contract','month'].includes(value.service_aggregation),'项目服务选档范围须为单份合同或当月合计');
  assert(typeof value.service_scope_confirmed==='boolean','请明确项目服务选档范围是否已确认');
  for(const type of ['product','service']) {
    assert(Array.isArray(value[type])&&value[type].length===SALES_POLICY[type].length,'金额档位数量无效');
    value[type].forEach((band,index)=>{
      assert(band&&typeof band==='object'&&!Array.isArray(band)&&Object.keys(band).length===2&&Object.hasOwn(band,'min')&&Object.hasOwn(band,'rates'),'金额档位格式无效');
      assert(Number.isSafeInteger(band.min)&&band.min>=0&&band.min<=1e12&&(index===0?band.min===0:band.min>value[type][index-1].min),'金额档位须从0开始并严格递增');
      assert(band.rates&&Object.keys(band.rates).length===4&&['D','C','B','A'].every(g=>Object.hasOwn(band.rates,g)),'绩效等级须为 D、C、B、A');
      for(const rate of Object.values(band.rates))assert(rate===null||typeof rate==='number'&&Number.isFinite(rate)&&rate>=0&&rate<=1,'提成比例须为0至100%，待核实格留空');
    });
  }
  return value;
}
