import { recordActivity } from './activity-events.mjs';
import {correctActivityEvent,correctLegacyActivity} from './activity-corrections.mjs';

/** activities: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleActivities(context) {
  if (context.path === '/api/activities' && context.method === 'POST') return recordActivity(context,context.b);
  const event=context.path.match(/^\/api\/activity-events\/(\d+)(\/void)?$/);
  if(event&&context.method===(event[2]?'POST':'PATCH'))return correctActivityEvent(context,Number(event[1]),event[2]?'void':'edit');
  const legacy=context.path.match(/^\/api\/activities\/(\d+)(\/void)?$/);
  if(legacy&&context.method===(legacy[2]?'POST':'PATCH'))return correctLegacyActivity(context,Number(legacy[1]),legacy[2]?'void':'edit');
}
