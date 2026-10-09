# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private
vulnerability reporting for this repository:

**https://github.com/Geekibo/rapid7-logger/security/advisories/new**

You will get an acknowledgement, and a fix or a mitigation will be published as a release with
credit if you want it. The package has zero runtime dependencies, so an advisory in a dependency
is never inherited through it.

## Supported versions

The latest published minor. Older versions receive no fixes; upgrade.

## The ingestion token is a write credential

The Rapid7 InsightOps ingestion token lets anyone who holds it write arbitrary lines into your
log estate. Treat it like a password:

- Pass it from a plain server environment variable such as `RAPID7_TOKEN`. **Never** from a
  `NEXT_PUBLIC_*` variable, which Next.js inlines into the browser bundle.
- **Never import this package from a browser.** The Next entry begins with
  `import 'server-only'`, so a Client Component import is a build error; CI builds a fixture
  with exactly that misuse and asserts it fails. The only sanctioned way to get a browser error
  into Rapid7 is a Route Handler that logs on the server (see the README).
- The logger never writes the token into a log line, a warning or an error message, and holds it
  in a private field so it cannot be enumerated or serialised.
- The Query API read key used by the live tests is a **separate** credential; keep it out of the
  shipped package and out of version control, as `.env.example` describes.

If you find a way the token can reach a client bundle, a log line or an error message, that is a
vulnerability — report it as above.
