import { ConsoleTransport } from '../../src/transports/console.js';
import { describeTransportContract } from './transport.contract.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describeTransportContract({
  name: 'ConsoleTransport',
  create: () => new ConsoleTransport({ console: silent }),
  drivenByFetch: false,
});
