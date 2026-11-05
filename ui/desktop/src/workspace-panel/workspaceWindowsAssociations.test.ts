import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openWindowsAssociation, queryWindowsAssociations } from './workspaceWindowsAssociations';

it.skipIf(process.platform !== 'win32')(
  'queries real Shell associations by type, treating quoted Unicode paths only as data',
  async () => {
    const plain = await queryWindowsAssociations('C:/fixture.json');
    const quoted = await queryWindowsAssociations("C:/中文 $(& 'do-not-execute').json");
    expect(quoted.defaultLabel).toBe(plain.defaultLabel);
    expect(quoted.handlers.map((item) => item.id)).toEqual(plain.handlers.map((item) => item.id));
    for (const file of ['C:/.gitignore', 'C:/fixture.png', 'C:/fixture.unknown_codebuddy_test']) {
      const result = await queryWindowsAssociations(file);
      expect(typeof result.defaultLabel).toBe('string');
      for (const item of result.handlers) {
        expect(item.id.length).toBeGreaterThan(0);
        expect(item.label.length).toBeGreaterThan(0);
        if (item.icon) expect(item.icon).toMatch(/^data:image\/png;base64,/);
      }
    }
  },
  30_000
);

it.skipIf(process.platform !== 'win32')(
  'refuses an unregistered app at invocation without changing the selected file',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-association-'));
    try {
      const file = path.join(root, '中文 & fixture.json');
      await fs.writeFile(file, '{"unchanged":true}');
      await expect(openWindowsAssociation(file, 'codebuddy-nonexistent-handler')).rejects.toThrow(
        'no longer associated'
      );
      expect(await fs.readFile(file, 'utf8')).toBe('{"unchanged":true}');
      await expect(openWindowsAssociation(path.join(root, 'missing.json'), 'any')).rejects.toThrow(
        'no longer available'
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
