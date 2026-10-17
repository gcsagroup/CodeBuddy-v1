import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePackagedCodeBuddyHome } from './codeBuddyPaths';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const rename = vi.fn(fs.renameSync);
  return { ...fs, renameSync: rename, default: { ...fs, renameSync: rename } };
});
afterEach(() => vi.mocked(renameSync).mockClear());
const fixture = () => mkdtempSync(join(tmpdir(), 'codebuddy-profile-retest-'));

describe('[retest-20261016] packaged default profile', () => {
  it('uses .CodeBuddy for a fresh synthetic home', () => {
    const home = fixture();
    expect(resolvePackagedCodeBuddyHome(home)).toBe(join(home, '.CodeBuddy'));
  });
  it('renames the old synthetic profile without changing its contents', () => {
    const home = fixture(),
      old = join(home, '.CodeBuddy-Harness'),
      current = join(home, '.CodeBuddy');
    mkdirSync(old);
    writeFileSync(join(old, 'fixture.json'), '{"fixtureOnly":true}');
    expect(resolvePackagedCodeBuddyHome(home)).toBe(current);
    expect(renameSync).toHaveBeenCalledWith(old, current);
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(current, 'fixture.json'), 'utf8')).toBe('{"fixtureOnly":true}');
  });
  it('preserves both directories and keeps the previous profile if both exist', () => {
    const home = fixture(),
      old = join(home, '.CodeBuddy-Harness'),
      current = join(home, '.CodeBuddy');
    mkdirSync(old);
    mkdirSync(current);
    writeFileSync(join(old, 'old.txt'), 'old fixture');
    writeFileSync(join(current, 'current.txt'), 'current fixture');
    expect(resolvePackagedCodeBuddyHome(home)).toBe(old);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expect(readFileSync(join(old, 'old.txt'), 'utf8')).toBe('old fixture');
    expect(readFileSync(join(current, 'current.txt'), 'utf8')).toBe('current fixture');
  });
  it('keeps existing data usable when Windows refuses the rename', () => {
    const home = fixture(),
      old = join(home, '.CodeBuddy-Harness');
    mkdirSync(old);
    writeFileSync(join(old, 'fixture.txt'), 'retained');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('fixture lock'), { code: 'EPERM' });
    });
    const warn = vi.fn();
    expect(resolvePackagedCodeBuddyHome(home, warn)).toBe(old);
    expect(warn).toHaveBeenCalledOnce();
    expect(readFileSync(join(old, 'fixture.txt'), 'utf8')).toBe('retained');
    expect(resolve(home)).not.toBe(resolve(tmpdir()));
  });
});
