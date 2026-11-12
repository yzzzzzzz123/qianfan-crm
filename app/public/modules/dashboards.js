import { analyticsPage } from './management-analytics.js';
import { assetPage } from './management-assets.js';
import { funnelPage } from './management-funnel.js';
import { personalPage } from './management-personal.js';

const views = {
  analytics: analyticsPage,
  assets: assetPage,
  funnel: funnelPage,
  personal: personalPage,
};

export function dashboard(S, P) {
  const render = views[P.view];
  return render ? `<link rel="stylesheet" href="./modules/management.css">${render(S, P)}` : '';
}

const inRange=(date,P)=>date&&(!P.from||date.slice(0,10)>=P.from)&&(!P.to||date.slice(0,10)<=P.to);
const contractSaleType=(S,contract)=>contract.sale_type??S.opportunities.find(opportunity=>opportunity.id===contract.opportunity_id)?.sale_type;
export function dashboardScope(S,P) {
  const owner=P.owner||(P.view==='personal'?String(S.actor.id):'');
  const own=row=>!owner||row.owner_id===Number(owner);
  const ownsCustomer=customer=>own(customer)||(customer.owner_id===null&&customer.collaborators?.includes(Number(owner)));
  const customerIds=new Set(S.customers.filter(customer=>!P.level||customer.manual_level===P.level).map(customer=>customer.id));
  const opportunities=S.opportunities.filter(row=>own(row)&&customerIds.has(row.customer_id)&&(!P.saleType||row.sale_type===P.saleType)&&(!P.from&&!P.to||inRange(row.created_at,P)));
  const paymentContracts=S.contracts.filter(row=>row.lifecycle!=='草稿'&&(!P.saleType||contractSaleType(S,row)===P.saleType)&&own(row)&&customerIds.has(row.customer_id));
  const contracts=paymentContracts.filter(row=>!P.from&&!P.to||inRange(row.sign_date,P));
  const opportunityIds=new Set(opportunities.map(row=>row.id));
  const inActivityScope=row=>opportunityIds.has(row.opportunity_id)&&(!P.from&&!P.to||inRange(row.activity_date,P));
  return {...S,customers:S.customers.filter(customer=>ownsCustomer(customer)&&customerIds.has(customer.id)),opportunities,contracts,paymentContracts,activities:S.activities.filter(inActivityScope),activityEvents:(S.activityEvents||[]).filter(inActivityScope),team:S.team.filter(user=>!owner||user.id===Number(owner))};
}
