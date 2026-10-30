import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createDesktopEscape, keyboardScript } from './desktopControlKeyboard';

describe.skipIf(process.platform !== 'win32')('native Escape observer', () => {
  it('accepts human Escape and excludes injected input, other keys and modifiers', () => {
    const probe = keyboardScript.replace(
      '[ControlEscape]::Run()',
      `
if(-not [ControlEscape]::HumanEscape(27,0,$false)){throw 'Human Escape rejected'}
foreach($flags in @(2,16,18)){if([ControlEscape]::HumanEscape(27,$flags,$false)){throw 'Injected Escape consumed'}}
if([ControlEscape]::HumanEscape(27,0,$true)){throw 'Modified shortcut consumed'}
if([ControlEscape]::HumanEscape(65,0,$false)){throw 'Unrelated key consumed'}
Write-Output 'PASS'
`
    );
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(probe, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('PASS');
  }, 20000);
  it('arms the latest turn asynchronously and disarms without generating input', async () => {
    const states: boolean[] = [];
    let ready!: () => void;
    const armed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const keyboard = createDesktopEscape(
      () => {
        throw Error('No keyboard input was sent');
      },
      (value) => {
        states.push(value);
        if (value) ready();
      }
    );
    try {
      keyboard.arm('old');
      keyboard.arm('current');
      await Promise.race([
        armed,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('Hook startup timed out')), 10000)
        ),
      ]);
      expect(states).toContain(true);
      keyboard.arm('');
    } finally {
      keyboard.close();
    }
  }, 15000);
});
