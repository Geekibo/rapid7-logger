import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The open-source hygiene documents (DESIGN §12) say specific things that must stay true.
const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');

describe('repository documents', () => {
  it('CONTRIBUTING states the credential-free run, the changeset rule and the release.yml hazard', () => {
    const text = read('CONTRIBUTING.md');
    expect(text).toMatch(/no credentials are needed/i);
    expect(text).toMatch(/expected to skip/);
    expect(text).toMatch(/npx changeset/);
    expect(text).toMatch(/Renaming `\.github\/workflows\/release\.yml` breaks publishing/);
    expect(text).toMatch(/pull_request_target/);
  });

  it('SECURITY links private reporting and calls the token a write credential', () => {
    const text = read('SECURITY.md');
    expect(text).toContain('https://github.com/Geekibo/rapid7-logger/security/advisories/new');
    expect(text).toMatch(/write credential/);
    expect(text).toMatch(/NEXT_PUBLIC_/);
  });

  it('CODE_OF_CONDUCT is the Contributor Covenant 2.1', () => {
    expect(read('CODE_OF_CONDUCT.md')).toMatch(/Contributor Covenant.*version 2\.1/s);
  });
});
