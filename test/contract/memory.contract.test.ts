import { MemoryTransport } from '../../src/transports/memory.js';
import { describeTransportContract } from './transport.contract.js';

describeTransportContract({
  name: 'MemoryTransport',
  create: () => new MemoryTransport(),
  drivenByFetch: false,
});
