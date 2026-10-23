import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePackagedCodeBuddyHome } from './codeBuddyPaths';

const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), 'codebuddy-profile-retest-')));

describe('packaged default profile isolation', () => {
  it('uses .CodeBuddy for a fresh synthetic home', () => {
    const home = fixture();
    expect(resolvePackagedCodeBuddyHome(home)).toBe(join(home, '.CodeBuddy'));
  });

  it('does not import or rename a previous installation profile', () => {
    const home = fixture();
    const old = join(home, '.CodeBuddy-Harness');
    const current = join(home, '.CodeBuddy');
    mkdirSync(old);
    writeFileSync(join(old, 'fixture.json'), '{"fixtureOnly":true}');
    expect(resolvePackagedCodeBuddyHome(home)).toBe(current);
    expect(existsSync(current)).toBe(false);
    expect(readFileSync(join(old, 'fixture.json'), 'utf8')).toBe('{"fixtureOnly":true}');
  });

  it('retains the installation own data when an older profile also exists', () => {
    const home = fixture();
    const old = join(home, '.CodeBuddy-Harness');
    const current = join(home, '.CodeBuddy');
    mkdirSync(old);
    mkdirSync(current);
    writeFileSync(join(old, 'old.txt'), 'old fixture');
    writeFileSync(join(current, 'current.txt'), 'current fixture');
    expect(resolvePackagedCodeBuddyHome(home)).toBe(current);
    expect(readFileSync(join(old, 'old.txt'), 'utf8')).toBe('old fixture');
    expect(readFileSync(join(current, 'current.txt'), 'utf8')).toBe('current fixture');
  });
});
