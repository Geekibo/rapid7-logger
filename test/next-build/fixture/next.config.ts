import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// The package is reached through node_modules/@geekibo/rapid7-logger -> the repository root,
// which is outside this app, so say where the root is rather than relying on lockfile inference.
const root = resolve(import.meta.dirname, '../../..');

const nextConfig: NextConfig = { turbopack: { root }, outputFileTracingRoot: root };

export default nextConfig;
