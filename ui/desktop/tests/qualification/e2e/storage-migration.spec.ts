import { expect, test } from '../../e2e/fixtures';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test.setTimeout(480_000);
test.use({ profileMode: 'isolated' });

test.describe('fresh unified storage', () => {
  test.use({ storageFixtureMode: 'fresh' });

  test('starts directly in the isolated .CodeBuddy profile', async ({
    appPage,
    isolatedProfileRoot,
  }) => {
    await expect(appPage.locator('#root')).toBeVisible();
    const home = join(isolatedProfileRoot, '.CodeBuddy');
    expect(existsSync(join(home, 'state', 'electron-app'))).toBe(true);
    expect(existsSync(join(home, 'profiles', 'local', 'state', 'electron'))).toBe(true);
    expect(existsSync(join(home, 'profiles', 'local', 'config', 'config.yaml'))).toBe(true);
    expect(existsSync(join(isolatedProfileRoot, 'AppData', 'Roaming', 'CodeBuddy'))).toBe(false);
    expect(existsSync(join(isolatedProfileRoot, 'AppData', 'Local', 'Block', 'goose'))).toBe(false);
  });
});

test.describe('legacy storage migration', () => {
  test.use({ storageFixtureMode: 'legacy' });

  test('copies, verifies, relaunches, and leaves legacy files unchanged', async ({
    appPage,
    isolatedProfileRoot,
  }) => {
    await expect(appPage.locator('#root')).toBeVisible();

    const legacyRoot = join(isolatedProfileRoot, 'AppData', 'Roaming', 'CodeBuddy');
    const home = join(isolatedProfileRoot, '.CodeBuddy');
    const legacySettings = readFileSync(join(legacyRoot, 'settings.json'), 'utf8');
    const legacyConfig = readFileSync(join(legacyRoot, 'backend', 'config', 'config.yaml'), 'utf8');
    const record = JSON.parse(readFileSync(join(home, 'migrations', 'migration.json'), 'utf8')) as {
      state: string;
      migration_id: string;
    };

    expect(record.state).toBe('committed');
    expect(record.migration_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(home, 'config', 'app.json'), 'utf8')).toBe(legacySettings);
    expect(readFileSync(join(home, 'profiles', 'local', 'config', 'config.yaml'), 'utf8')).toBe(
      legacyConfig
    );
    expect(readFileSync(join(legacyRoot, 'settings.json'), 'utf8')).toBe(legacySettings);
    expect(readFileSync(join(legacyRoot, 'backend', 'config', 'config.yaml'), 'utf8')).toBe(
      legacyConfig
    );
    expect(existsSync(join(home, 'state', 'electron-app'))).toBe(true);
    expect(existsSync(join(home, 'profiles', 'local', 'state', 'electron'))).toBe(true);
  });
});
