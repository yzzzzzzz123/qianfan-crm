// Keep stored lifecycle values while presenting the business status.
export const contractStatusLabel=value=>value==='已归档'?'已签署':value==='草稿'?'待确认签署':value||'历史登记';
