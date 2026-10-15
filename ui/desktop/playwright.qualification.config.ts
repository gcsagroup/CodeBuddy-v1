import defaultConfig from './playwright.config';

export default {
  ...defaultConfig,
  testDir: './tests/qualification/e2e',
  testMatch: ['codebuddy-qualification.spec.ts', 'storage-migration.spec.ts'],
  outputDir: 'test-results/qualification',
  maxFailures: 1,
  reporter: [['html', { outputFolder: 'playwright-report/qualification' }], ['list']],
};
