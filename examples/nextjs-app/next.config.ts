import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// The package is installed from `file:../..` — a symlink to the repository root, which is outside
// this app — so tell the bundler where the project root is. A consumer installing from npm
// does not need either line.
const root = resolve(import.meta.dirname, '../..');

const nextConfig: NextConfig = { turbopack: { root }, outputFileTracingRoot: root };

export default nextConfig;
