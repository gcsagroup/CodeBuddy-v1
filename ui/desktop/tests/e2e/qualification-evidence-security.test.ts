import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  buildQualificationChildEnvironment,
  createWindowsProcessTreeCleanupTask,
  qualificationSensitivePaths,
  resolveQualificationCorepackHome,
  resetLauncherExitState,
  sanitizeQualificationEvidence,
  waitForQualificationCleanup,
  waitForPipeDrain,
} from './fixtures';
import {
  recordDeterministicRouteTrace,
  startDeterministicOpenAiServer,
} from './deterministic-openai-server';

async function streamedCompletionText(response: Response): Promise<string> {
  return (await response.text())
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
    .flatMap(
      (chunk) => (chunk.choices as Array<{ delta?: { content?: string } }> | undefined) ?? []
    )
    .map((choice) => choice.delta?.content ?? '')
    .join('');
}

describe('qualification diagnostic evidence security', () => {
  it('records only bounded route metadata and never logs goal, tool arguments, or credentials', () => {
    const logged: string[] = [];
    const traces: unknown[] = [];
    const secret = 'sk-real-secret-value';
    const password = 'correct-horse-battery-staple';
    const trace = recordDeterministicRouteTrace(
      {
        messages: [
          { role: 'system', content: '# CodePro single-file change' },
          {
            role: 'user',
            content: `edit private-goal.txt with {"token":"${secret}","password":"${password}"}`,
          },
          {
            role: 'tool',
            content: `{"path":"C:\\Users\\Alice\\private.txt","apiKey":"${secret}"}`,
          },
        ],
      },
      7,
      traces,
      (line) => logged.push(line)
    );

    assert.deepEqual(trace, {
      requestSequence: 7,
      stage: 'single_file',
      markers: {
        semantic: false,
        planner: false,
        singleFile: true,
        coder: false,
        tester: false,
        reviewer: false,
      },
      toolResults: 1,
    });
    const evidence = JSON.stringify({ traces, logged });
    for (const forbidden of ['private-goal.txt', 'private.txt', secret, password, 'apiKey']) {
      assert.doesNotMatch(
        evidence,
        new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')
      );
    }
  });

  it('plans the L2 coder before an exact host-verifiable tester command', async () => {
    const server = await startDeterministicOpenAiServer();
    try {
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'CodePro 的主 Agent 和需求分析专家' },
            { role: 'user', content: '实现问候路由' },
          ],
        }),
      });
      assert.equal(response.status, 200);

      const plannerText = await streamedCompletionText(response);
      const plan = JSON.parse(plannerText) as {
        tasks: Array<{
          id: string;
          role: string;
          depends_on: string[];
          description: string;
          acceptance_criteria: string;
          scope: { write_scope: string[] };
        }>;
      };
      assert.equal(plan.tasks.length, 2);
      const [coder, tester] = plan.tasks;
      assert.equal(coder.role, 'coder');
      assert.equal(tester.role, 'tester');
      assert.deepEqual(tester.depends_on, [coder.id]);
      assert.equal(tester.description, '运行命令 `node --test`');
      assert.deepEqual(tester.scope.write_scope, []);
      assert.match(tester.acceptance_criteria, /node --test/u);
      assert.match(tester.acceptance_criteria, /退出码为 0/u);
      assert.match(tester.acceptance_criteria, /没有失败用例/u);

      assert.deepEqual(server.routeTrace(), [
        {
          requestSequence: 1,
          stage: 'planner',
          markers: {
            semantic: false,
            planner: true,
            singleFile: false,
            coder: false,
            tester: false,
            reviewer: false,
          },
          toolResults: 0,
        },
      ]);
      assert.doesNotMatch(JSON.stringify(server.routeTrace()), /实现问候路由|node --test/u);
    } finally {
      await server.close();
    }
  });

  it('plans the P0 host diagnostic before the repair coder', async () => {
    const server = await startDeterministicOpenAiServer({ scenario: 'p0-repair' });
    try {
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'CodePro 的主 Agent 和需求分析专家' },
            { role: 'user', content: '多文件修复加法功能' },
          ],
        }),
      });
      const plannerText = await streamedCompletionText(response);
      const plan = JSON.parse(plannerText) as {
        tasks: Array<{ id: string; role: string; depends_on: string[]; description: string }>;
      };
      assert.deepEqual(
        plan.tasks.map((task) => ({ id: task.id, role: task.role, dependsOn: task.depends_on })),
        [
          { id: 'diagnostic', role: 'tester', dependsOn: [] },
          { id: 'code', role: 'coder', dependsOn: ['diagnostic'] },
        ]
      );
      assert.match(plan.tasks[0].description, /node tests\.js/u);

      const testerResponse = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: '你的角色是测试 Agent' },
            { role: 'tool', content: 'PASS add_returns_four; exit code 0' },
          ],
        }),
      });
      const testerReport = await streamedCompletionText(testerResponse);
      assert.match(testerReport, /验证：node tests\.js；通过，0 失败，退出码 0/u);
      assert.doesNotMatch(testerReport, /node --test/u);
    } finally {
      await server.close();
    }
  });

  it('redacts slash, backslash, double-escaped, and case variants of sensitive Windows paths', () => {
    const profile = 'C:\\Users\\Alice\\AppData\\Local\\Temp\\Profile-123';
    const workspace = 'D:\\Work\\Secret Project';
    const evidence = [
      'C:/Users/Alice/AppData/Local/Temp/Profile-123/state.db',
      'c:\\users\\alice\\appdata\\local\\temp\\profile-123\\state.db',
      'C:\\\\Users\\\\Alice\\\\AppData\\\\Local\\\\Temp\\\\Profile-123\\\\state.db',
      'd:/WORK/SECRET PROJECT/src/private.ts',
      'D:\\\\Work\\\\Secret Project\\\\src\\\\private.ts',
      'Authorization: Bearer top-secret',
      '{"token":"token-secret","password":"password-secret","api_key":"key-secret"}',
    ].join('\n');

    const sanitized = sanitizeQualificationEvidence(evidence, [profile, workspace]);

    assert.equal(sanitized.match(/<redacted-path>/gu)?.length, 5);
    for (const forbidden of [
      'Users/Alice',
      'users\\alice',
      'Users\\\\Alice',
      'Secret Project',
      'top-secret',
      'token-secret',
      'password-secret',
      'key-secret',
    ]) {
      assert.equal(sanitized.includes(forbidden), false);
    }
  });

  it('collects the qualification source workspace root for evidence redaction', () => {
    const sourceWorkspaceRoot = resolve(process.cwd(), '..', '..');
    const evidence = [
      `${sourceWorkspaceRoot.replaceAll('\\', '/')}/ui/sdk/openapi-ts-error.log`,
      `${sourceWorkspaceRoot.toUpperCase()}\\ui\\node_modules\\playwright\\cli.js`,
      `${sourceWorkspaceRoot.replaceAll('\\', '\\\\')}\\\\ui\\\\sdk\\\\generated.ts`,
    ].join('\n');

    const sanitized = sanitizeQualificationEvidence(evidence, qualificationSensitivePaths({}, []));

    assert.equal(
      sanitized.match(/<redacted-path>/gu)?.length ?? 0,
      3,
      'qualification evidence must redact every source workspace path variant'
    );
  });

  it('redacts complete quoted JSON credential values with separators and escapes', () => {
    const secrets = [
      'token with spaces, commas; semicolons \\ paths and "quoted" text',
      'password with spaces, commas; semicolons \\ paths and "quoted" text',
    ];
    const evidence = JSON.stringify({ token: secrets[0], password: secrets[1] });

    const sanitized = sanitizeQualificationEvidence(evidence, []);

    for (const fragment of ['with spaces', 'commas', 'semicolons', 'paths', 'quoted', '\\\\']) {
      assert.equal(sanitized.includes(fragment), false);
    }
    assert.equal(sanitized, '{"token":"<redacted>","password":"<redacted>"}');
  });

  it('redacts complete quoted JSON Authorization values with escaped quotes', () => {
    const evidence = JSON.stringify({
      Authorization: 'Bearer secret with spaces,comma;and\\"quote',
    });

    const sanitized = sanitizeQualificationEvidence(evidence, []);

    assert.equal(sanitized, '{"Authorization":"<redacted>"}');
    for (const fragment of ['Bearer', 'secret', 'spaces', 'comma', 'quote']) {
      assert.equal(sanitized.includes(fragment), false);
    }
  });

  it('constructs a minimal isolated child environment without reading credential-like values', () => {
    const parent: NodeJS.ProcessEnv = {
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATH: 'C:\\node;C:\\offline\\pnpm;C:\\offline\\corepack',
      PATHEXT: '.EXE;.CMD',
      NODE_PATH: 'C:\\node\\modules',
      PNPM_HOME: 'C:\\offline\\pnpm',
      COREPACK_HOME: 'C:\\offline\\corepack',
      LIBCLANG_PATH: 'C:\\offline\\llvm\\bin',
      CXXFLAGS: '/utf-8 /EHsc',
      CI: 'true',
    };
    for (const name of ['OPENAI_API_KEY', 'github_token', 'CUSTOM_PASSWORD', 'AZURE_SECRET']) {
      Object.defineProperty(parent, name, {
        enumerable: true,
        get: () => {
          throw new Error(`credential value was read: ${name}`);
        },
      });
    }

    const environment = buildQualificationChildEnvironment(parent, {
      profileRoot: 'C:\\isolated',
      appData: 'C:\\isolated\\AppData\\Roaming',
      localAppData: 'C:\\isolated\\AppData\\Local',
      codeBuddyHome: 'C:\\isolated\\.CodeBuddy',
      temporaryDirectory: 'C:\\isolated\\Temp',
      workingDirectory: 'D:\\fixture',
      deterministicBaseUrl: 'http://127.0.0.1:40123',
      corepackHome: 'C:\\offline\\corepack',
      cargoHome: 'C:\\offline\\cargo',
      rustupHome: 'C:\\offline\\rustup',
    });

    assert.deepEqual(
      Object.fromEntries(
        Object.keys({
          SystemRoot: true,
          ComSpec: true,
          PATH: true,
          NODE_PATH: true,
          PNPM_HOME: true,
          COREPACK_HOME: true,
          CARGO_HOME: true,
          RUSTUP_HOME: true,
          APPDATA: true,
          LOCALAPPDATA: true,
          HOME: true,
          USERPROFILE: true,
          TEMP: true,
          TMP: true,
          OPENAI_API_KEY: true,
          OPENAI_BASE_URL: true,
        }).map((key) => [key, environment[key]])
      ),
      {
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATH: 'C:\\node;C:\\offline\\pnpm;C:\\offline\\corepack',
        NODE_PATH: 'C:\\node\\modules',
        PNPM_HOME: 'C:\\offline\\pnpm',
        COREPACK_HOME: 'C:\\offline\\corepack',
        CARGO_HOME: 'C:\\offline\\cargo',
        RUSTUP_HOME: 'C:\\offline\\rustup',
        APPDATA: 'C:\\isolated\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\isolated\\AppData\\Local',
        HOME: 'C:\\isolated',
        USERPROFILE: 'C:\\isolated',
        TEMP: 'C:\\isolated\\Temp',
        TMP: 'C:\\isolated\\Temp',
        OPENAI_API_KEY: 'codepro-e2e-local-only',
        OPENAI_BASE_URL: 'http://127.0.0.1:40123/v1',
      }
    );
    assert.equal(Object.hasOwn(environment, 'github_token'), false);
    assert.equal(Object.hasOwn(environment, 'CUSTOM_PASSWORD'), false);
    assert.equal(Object.hasOwn(environment, 'AZURE_SECRET'), false);
    assert.equal(Object.hasOwn(environment, 'CI'), false);
    assert.equal(environment.LIBCLANG_PATH, 'C:\\offline\\llvm\\bin');
    assert.equal(environment.CXXFLAGS, '/utf-8 /EHsc');
  });

  it('redacts parent profile and temporary roots from PATH in every Windows spelling', () => {
    const parent: NodeJS.ProcessEnv = {
      USERPROFILE: 'C:\\Profiles\\Alice',
      HOME: 'D:\\Homes\\Alice',
      APPDATA: 'E:\\Roaming\\Alice',
      LOCALAPPDATA: 'F:\\Local\\Alice',
      TEMP: 'G:\\Temp\\Alice',
      TMP: 'H:\\Tmp\\Alice',
      PATH: [
        'C:/Profiles/Alice/bin',
        'd:\\homes\\alice\\bin',
        'E:\\\\ROAMING\\\\ALICE\\\\npm',
        'f:/LOCAL/ALICE/pnpm',
        'G:\\Temp\\Alice\\cache',
        'h:\\\\tmp\\\\alice\\\\cache',
      ].join(';'),
    };

    const roots = qualificationSensitivePaths(parent, []);
    const sanitized = sanitizeQualificationEvidence(parent.PATH ?? '', roots);

    for (const fragment of [
      'Profiles/Alice',
      'homes\\alice',
      'ROAMING\\\\ALICE',
      'LOCAL/ALICE',
      'Temp\\Alice',
      'tmp\\\\alice',
    ]) {
      assert.equal(sanitized.toLowerCase().includes(fragment.toLowerCase()), false);
    }
    assert.equal(sanitized.match(/<redacted-path>/gu)?.length, 6);
  });

  it('runs pnpm from the verified local Corepack cache without network or cache writes', () => {
    const corepackHome = resolveQualificationCorepackHome(process.env);
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'codepro-qualification-runtime-'));
    const lastKnownGood = join(corepackHome, 'lastKnownGood.json');
    const before = {
      rootMtimeMs: statSync(corepackHome).mtimeMs,
      versionsMtimeMs: statSync(join(corepackHome, 'v1')).mtimeMs,
      lastKnownGood: readFileSync(lastKnownGood),
    };

    try {
      const environment = buildQualificationChildEnvironment(process.env, {
        profileRoot: runtimeRoot,
        appData: join(runtimeRoot, 'AppData', 'Roaming'),
        localAppData: join(runtimeRoot, 'AppData', 'Local'),
        codeBuddyHome: join(runtimeRoot, '.CodeBuddy'),
        temporaryDirectory: join(runtimeRoot, 'Temp'),
        corepackHome,
      });
      const result = spawnSync(
        environment.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'pnpm.cmd --version'],
        {
          cwd: process.cwd(),
          env: environment,
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        }
      );

      const version = result.stdout?.trim() ?? '';
      console.log(`[qualification-security] pnpm.cmd --version => ${version}`);
      assert.equal(result.error, undefined, 'pnpm preflight process did not start');
      assert.equal(result.status, 0, `pnpm preflight exit was ${result.status}`);
      assert.equal(result.signal, null);
      assert.match(version, /^\d+\.\d+\.\d+(?:[-+].+)?$/u);
      assert.equal(environment.COREPACK_HOME, corepackHome);
      assert.equal(environment.COREPACK_ENABLE_NETWORK, '0');
      assert.equal(environment.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }

    assert.deepEqual(
      {
        rootMtimeMs: statSync(corepackHome).mtimeMs,
        versionsMtimeMs: statSync(join(corepackHome, 'v1')).mtimeMs,
        lastKnownGood: readFileSync(lastKnownGood),
      },
      before
    );
  });

  it('resets all launcher exit fields for every relaunch', () => {
    assert.deepEqual(
      resetLauncherExitState(
        {
          pid: 101,
          exited: true,
          exitCode: 9,
          exitSignal: 'SIGTERM',
        },
        202
      ),
      { pid: 202, exited: false, exitCode: null, exitSignal: null }
    );
  });

  it('aggregates every cleanup step without swallowing failures and permits not-needed steps', async () => {
    let closeFinished = false;
    const close = new Promise<void>((resolve) => {
      setTimeout(() => {
        closeFinished = true;
        resolve();
      }, 10);
    });
    assert.deepEqual(
      await waitForQualificationCleanup(
        {
          browserClose: Promise.resolve(),
          electronTreeKill: undefined,
          launcherTreeKill: undefined,
          serverClose: Promise.resolve(),
          launcherClose: close,
          stdoutDrain: Promise.resolve(),
          stderrDrain: Promise.resolve(),
        },
        100,
        []
      ),
      {
        status: 'completed',
        browserClose: { status: 'completed' },
        electronTreeKill: { status: 'not_needed' },
        launcherTreeKill: { status: 'not_needed' },
        serverClose: { status: 'completed' },
        launcherClose: { status: 'completed' },
        stdoutDrain: { status: 'completed' },
        stderrDrain: { status: 'completed' },
      }
    );
    assert.equal(closeFinished, true);

    for (const step of [
      'browserClose',
      'electronTreeKill',
      'launcherTreeKill',
      'serverClose',
    ] as const) {
      const outcome = await waitForQualificationCleanup(
        { [step]: Promise.reject(new Error('C:\\Users\\Alice token=secret-value')) },
        100,
        ['C:\\Users\\Alice']
      );
      assert.equal(outcome.status, 'failed');
      assert.deepEqual(outcome[step], {
        status: 'failed',
        error: '<redacted-path> token=<redacted>',
      });

      const timeout = await waitForQualificationCleanup(
        { [step]: new Promise<void>(() => undefined) },
        10,
        []
      );
      assert.equal(timeout.status, 'timed_out');
      assert.deepEqual(timeout[step], { status: 'timed_out' });
    }
  });

  it('uses Windows process liveness postconditions without hiding access failures', async () => {
    let taskkillCalls = 0;
    const notNeeded = createWindowsProcessTreeCleanupTask(41, Promise.resolve(), {
      probe: () => false,
      taskkill: async () => {
        taskkillCalls += 1;
      },
      gracePeriodMs: 0,
    });
    assert.equal(notNeeded, undefined);
    assert.equal(taskkillCalls, 0);

    let reusedPidTaskkillCalls = 0;
    const authoritativeCloseWithReusedPid = createWindowsProcessTreeCleanupTask(
      49,
      Promise.resolve(),
      {
        probe: () => true,
        taskkill: async () => {
          reusedPidTaskkillCalls += 1;
          throw Object.assign(new Error('must not target a reused PID'), { code: 5 });
        },
        gracePeriodMs: 0,
      },
      { authoritativeGracefulClose: true }
    );
    assert.ok(authoritativeCloseWithReusedPid);
    await assert.doesNotReject(authoritativeCloseWithReusedPid);
    assert.equal(reusedPidTaskkillCalls, 0);

    let delayedCloseResolve: (() => void) | undefined;
    let delayedCloseTaskkillCalls = 0;
    const delayedAuthoritativeClose = new Promise<void>((resolve) => {
      delayedCloseResolve = resolve;
    });
    const delayedAuthoritativeTask = createWindowsProcessTreeCleanupTask(
      50,
      delayedAuthoritativeClose,
      {
        probe: () => true,
        taskkill: async () => {
          delayedCloseTaskkillCalls += 1;
          throw Object.assign(new Error('grace period ended too soon'), { code: 5 });
        },
      },
      { authoritativeGracefulClose: true }
    );
    assert.ok(delayedAuthoritativeTask);
    setTimeout(() => delayedCloseResolve?.(), 300);
    await assert.doesNotReject(delayedAuthoritativeTask);
    assert.equal(delayedCloseTaskkillCalls, 0);

    let finishGracefulClose: (() => void) | undefined;
    const gracefulEvents: string[] = [];
    const gracefulClose = new Promise<void>((resolve) => {
      finishGracefulClose = resolve;
    });
    const gracefulProbes = [true, false];
    const gracefulCompletion = createWindowsProcessTreeCleanupTask(46, gracefulClose, {
      probe: () => {
        gracefulEvents.push('probe');
        return gracefulProbes.shift() ?? false;
      },
      taskkill: async () => {
        gracefulEvents.push('taskkill');
        taskkillCalls += 1;
      },
      gracePeriodMs: 100,
    });
    assert.ok(gracefulCompletion);
    await Promise.resolve();
    assert.deepEqual(gracefulEvents, ['probe']);
    finishGracefulClose?.();
    const gracefulAggregate = await waitForQualificationCleanup(
      { electronTreeKill: gracefulCompletion },
      100,
      []
    );
    assert.equal(gracefulAggregate.status, 'completed');
    assert.equal(gracefulAggregate.electronTreeKill.status, 'completed');
    assert.deepEqual(gracefulEvents, ['probe', 'probe']);
    assert.equal(taskkillCalls, 0);

    const completedProbes = [true, true, false];
    const completed = createWindowsProcessTreeCleanupTask(42, Promise.resolve(), {
      probe: () => completedProbes.shift() ?? false,
      taskkill: async () => {
        taskkillCalls += 1;
        throw Object.assign(new Error('already gone'), {
          code: 128,
          stderr:
            'ERROR: The process with PID 42 could not be terminated.\n' +
            'Reason: There is no running instance of the task.\n',
        });
      },
      gracePeriodMs: 0,
    });
    assert.ok(completed);
    await assert.doesNotReject(completed);
    assert.equal(taskkillCalls, 1);
    const completedAggregate = await waitForQualificationCleanup(
      { electronTreeKill: completed },
      100,
      []
    );
    assert.equal(completedAggregate.status, 'completed');
    assert.equal(completedAggregate.electronTreeKill.status, 'completed');

    const stillRunningProbes = [true, true, true];
    const stillRunning = createWindowsProcessTreeCleanupTask(43, Promise.resolve(), {
      probe: () => stillRunningProbes.shift() ?? true,
      taskkill: async () => {
        throw Object.assign(new Error('already gone'), {
          code: 128,
          stderr:
            'ERROR: The process with PID 43 could not be terminated.\n' +
            'Reason: There is no running instance of the task.\n',
        });
      },
      gracePeriodMs: 0,
    });
    assert.ok(stillRunning);
    await assert.rejects(stillRunning);

    const accessDenied = createWindowsProcessTreeCleanupTask(44, Promise.resolve(), {
      probe: () => true,
      taskkill: async () => {
        throw Object.assign(new Error('access denied'), { code: 5 });
      },
      gracePeriodMs: 0,
    });
    assert.ok(accessDenied);
    const aggregate = await waitForQualificationCleanup(
      { electronTreeKill: accessDenied },
      100,
      []
    );
    assert.equal(aggregate.status, 'failed');
    assert.equal(aggregate.electronTreeKill.status, 'failed');

    const mixedDeniedProbes = [true, true, false];
    const mixedDenied = createWindowsProcessTreeCleanupTask(47, Promise.resolve(), {
      probe: () => mixedDeniedProbes.shift() ?? false,
      taskkill: async () => {
        throw Object.assign(new Error('mixed taskkill failure'), {
          code: 128,
          stderr:
            'ERROR: The process with PID 47 could not be terminated.\n' +
            'Reason: There is no running instance of the task.\n' +
            'ERROR: The process with PID 48 could not be terminated.\n' +
            'Reason: Access is denied.\n',
        });
      },
      gracePeriodMs: 0,
    });
    assert.ok(mixedDenied);
    await assert.rejects(mixedDenied);

    const postProbeDenied = createWindowsProcessTreeCleanupTask(48, Promise.resolve(), {
      probe: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          if (calls < 3) return true;
          throw Object.assign(new Error('probe unavailable'), { code: 'EPERM' });
        };
      })(),
      taskkill: async () => {
        throw Object.assign(new Error('already gone'), {
          code: 128,
          stderr:
            'ERROR: The process with PID 48 could not be terminated.\n' +
            'Reason: There is no running instance of the task.\n',
        });
      },
      gracePeriodMs: 0,
    });
    assert.ok(postProbeDenied);
    await assert.rejects(postProbeDenied);

    const probeDenied = createWindowsProcessTreeCleanupTask(45, Promise.resolve(), {
      probe: () => {
        throw Object.assign(new Error('probe unavailable'), { code: 'EPERM' });
      },
      taskkill: async () => {
        throw new Error('must not run');
      },
      gracePeriodMs: 0,
    });
    assert.ok(probeDenied);
    const probeAggregate = await waitForQualificationCleanup(
      { launcherTreeKill: probeDenied },
      100,
      []
    );
    assert.equal(probeAggregate.status, 'failed');
    assert.equal(probeAggregate.launcherTreeKill.status, 'failed');
  });

  it('bounds deterministic server close and reports timeout structurally', async () => {
    const outcome = await waitForQualificationCleanup(
      { serverClose: new Promise<void>(() => undefined) },
      10,
      []
    );

    assert.equal(outcome.status, 'timed_out');
    assert.deepEqual(outcome.serverClose, { status: 'timed_out' });
  });

  it('maps stdout and stderr stream errors to failed and bounds each drain timeout', async () => {
    for (const step of ['stdoutDrain', 'stderrDrain'] as const) {
      const failedStream = new PassThrough();
      const failedDrain = waitForPipeDrain(failedStream);
      failedStream.emit('error', new Error('token=stream-secret'));
      const failed = await waitForQualificationCleanup({ [step]: failedDrain }, 100, []);
      assert.equal(failed.status, 'failed');
      assert.deepEqual(failed[step], {
        status: 'failed',
        error: 'token=<redacted>',
      });

      const pendingStream = new PassThrough();
      const timedOut = await waitForQualificationCleanup(
        { [step]: waitForPipeDrain(pendingStream) },
        10,
        []
      );
      assert.equal(timedOut.status, 'timed_out');
      assert.deepEqual(timedOut[step], { status: 'timed_out' });
      pendingStream.destroy();
    }
  });
});
