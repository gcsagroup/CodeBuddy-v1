const { chromium } = require('@playwright/test');
const path = require('node:path');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`Missing --${name}`);
  }
  return process.argv[index + 1];
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function connect(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Installed app did not expose CDP: ${lastError}`);
}

async function main() {
  const port = Number(argument('port'));
  const fixtureRoot = path.resolve(argument('fixture-root'));
  const fixtureFile = path.resolve(argument('fixture-file'));
  const expectedContent = argument('expected-content');
  const timeoutMs = Number(process.env.CODEBUDDY_LIFECYCLE_TIMEOUT_MS || 120_000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid lifecycle debug port');
  }

  const browser = await connect(port, timeoutMs);
  let page;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => !candidate.url().startsWith('devtools://'));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('Installed app did not create a renderer page');
  await page.locator('#root').waitFor({ state: 'visible', timeout: timeoutMs });

  const observed = await page.evaluate(
    async ({ fixtureFile }) => ({
      recentDirectories: await window.electron.listRecentDirs(),
      file: await window.electron.readFile(fixtureFile),
      appVersion: window.electron.getVersion(),
      profileRoot: window.appConfig.get('GOOSE_PATH_ROOT'),
      workingDir: window.appConfig.get('GOOSE_WORKING_DIR'),
    }),
    { fixtureFile }
  );
  if (typeof observed.workingDir !== 'string' || !samePath(observed.workingDir, fixtureRoot)) {
    throw new Error(`Fixture project was not opened: ${JSON.stringify(observed.workingDir)}`);
  }
  if (!observed.file?.found || observed.file.file !== expectedContent) {
    throw new Error('Installed desktop bridge did not read the fixture file exactly');
  }

  process.stdout.write(
    `${JSON.stringify({
      result: 'pass',
      SAFE_LOCAL_TASK: 'PASS',
      projectOpen: true,
      appVersion: observed.appVersion,
      profileRoot: observed.profileRoot,
      workingDir: observed.workingDir,
      recentDirectoryCount: observed.recentDirectories.length,
    })}\n`
  );
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
