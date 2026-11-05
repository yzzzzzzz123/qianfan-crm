import { recordActivity } from './activity-events.mjs';

/** activities: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleActivities(context) {
  if (context.path === '/api/activities' && context.method === 'POST') return recordActivity(context,context.b);
}
