import { Rapid7WebhookTransport } from '../../src/transports/rapid7-webhook.js';
import { describeTransportContract } from './transport.contract.js';

// Shape-valid, not real: the endpoint accepts any GUID (§2.6). No test here reaches the network.
const TOKEN = 'deadbeef-dead-4bad-8bad-feedfacecafe';
const accept = (() =>
  Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch;

describeTransportContract({
  name: 'Rapid7WebhookTransport',
  create: (fetchImpl = accept) =>
    new Rapid7WebhookTransport({ token: TOKEN, fetch: fetchImpl, maxAttempts: 1, timeoutMs: 50 }),
  drivenByFetch: true,
});
