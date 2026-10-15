import { describe, expect, it } from 'vitest';
import { resolveStartupDirectory } from './startupDirectory';

describe('resolveStartupDirectory', () => {
  it('preserves a Windows working directory supplied through the environment', () => {
    expect(resolveStartupDirectory([], String.raw`C:\Users\tester\UserProject`)).toBe(
      String.raw`C:\Users\tester\UserProject`
    );
  });

  it('prefers an explicit command-line directory', () => {
    expect(
      resolveStartupDirectory(['--', '--dir', String.raw`D:\explicit`], String.raw`C:\fallback`)
    ).toBe(String.raw`D:\explicit`);
  });

  it('leaves an unbound launch without a directory', () => {
    expect(resolveStartupDirectory([], '   ')).toBeNull();
  });
});
