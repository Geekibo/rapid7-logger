'use server';
import { withLogging } from '@geekibo/rapid7-logger/next';
import { log } from '@/lib/log';

// A form action must resolve void; withLogging keeps fn's exact type, so these do.
export const publishSurvey = withLogging(log, 'publishSurvey', async (log, formData: FormData) => {
  const id = Number(formData.get('id') ?? 42);
  log.info('publishing', { id });
});

export const failSurvey = withLogging(log, 'failSurvey', async (log, _formData: FormData) => {
  log.info('about to fail');
  throw new Error('boom: deliberate action error');
});
