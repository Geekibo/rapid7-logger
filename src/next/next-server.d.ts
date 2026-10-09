// `next` is an optional peer and is not installed here, so `import('next/server')` needs a
// declaration to type-check. `unknown` on purpose: the runtime narrows with `typeof`, and this
// file never reaches dist/ (verified: the bundled .d.ts mentions no `next/server`). Do not turn
// this into a typed signature — it would conflict with the real one in a consumer's build.
declare module 'next/server' {
  export const after: unknown;
  export const unstable_after: unknown;
}
