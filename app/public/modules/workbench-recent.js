import {customerName, userName} from '../ui.js';
import {selectActivityGroups} from './activities.js';

const systemLabels = ['系统', '系统里程碑'];
const isRecentFollowup = event => event.id && !event.source_withdrawn &&
  !systemLabels.includes(event.activity_type) && !systemLabels.includes(event.source);
const newestFirst = (a, b) => b.activity_date.localeCompare(a.activity_date) ||
  String(b.created_at || '').localeCompare(String(a.created_at || '')) ||
  Number(b.id) - Number(a.id);

export function workbenchRecent(S, owner = '') {
  const opportunities = new Map((S.opportunities || []).map(o => [Number(o.id), o]));
  const customers = new Map((S.customers || []).map(c => [Number(c.id), c]));

  return selectActivityGroups(S, {activityOwner: owner})
    .map(({events}) => events.filter(isRecentFollowup).sort(newestFirst)[0])
    .filter(Boolean)
    .sort(newestFirst)
    .slice(0, 4)
    .map(event => {
      const opportunity = opportunities.get(Number(event.opportunity_id));
      const customerId = opportunity?.customer_id ?? event.customer_id;
      const record = customers.get(Number(customerId));
      const customer = record?.short_name || record?.name || event.customer_name || customerName(S, customerId);
      const source = event.source || '未提供';
      return {
        id: event.id,
        action: event.legacy ? 'activity-legacy-detail' : 'activity-event-detail',
        opportunityId: opportunity?.id ?? null,
        customer: customer || '客户',
        summary: event.summary || '',
        author: event.user_name || userName(S, event.user_id),
        source: event.source_stale ? `${source} · 历史版本` : source,
        date: event.activity_date,
      };
    });
}
