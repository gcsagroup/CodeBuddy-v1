const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const crypto = require('crypto');
const fs = require('fs');
const { resolve, sep } = require('path');
const distro = require('./codebuddy.distro.json');
const desktopPackage = require('./package.json');
const { stagePty, preparePty } = require('./scripts/macos-package.cjs');
const {
  macSigningOptionsForFile,
  ignoreNonMacCode,
} = require('../../scripts/macos-tool-artifacts.cjs');
const { signingPlan } = require('./scripts/macos-signing.cjs');

const isLinuxVulkanBuild = process.env.GOOSE_DESKTOP_LINUX_VARIANT === 'vulkan';
const harnessResourceDir = process.env.CODEBUDDY_HARNESS_RESOURCE_DIR;
if (harnessResourceDir) {
  const manifest = JSON.parse(
    fs.readFileSync(resolve(harnessResourceDir, 'manifest.json'), 'utf8')
  );
  if (manifest.engine !== 'deepseek-harness' || manifest.schemaVersion !== 1)
    throw new Error('Invalid Harness distribution stage');
  for (const entry of manifest.files) {
    const file = resolve(harnessResourceDir, entry.path);
    if (
      !file.startsWith(resolve(harnessResourceDir) + sep) ||
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256
    ) {
      throw new Error('Harness distribution stage identity mismatch');
    }
  }
}
if (
  process.argv.some((argument) => ['package', 'make'].includes(argument)) &&
  !harnessResourceDir
) {
  throw new Error(
    'Packaging requires a verified Harness distribution stage; use scripts/build-harness-windows.cjs or scripts/build-harness-macos.cjs on the native host.'
  );
}
const electronArtifactName = `electron-v${desktopPackage.devDependencies.electron}-win32-x64.zip`;
const electronArtifactSha256 = 'bbb798d1817bc173a187c1de30432247e48046f737fa13ade126fe3788303b81';
const requestedTarget = (name) => {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const optionIndex = process.argv.indexOf(`--${name}`);
  return optionIndex >= 0 ? process.argv[optionIndex + 1] : undefined;
};
const targetPlatform = requestedTarget('platform') || process.platform;
const useWindowsX64Checksum =
  requestedTarget('platform') === 'win32' && requestedTarget('arch') === 'x64';

let cfg = {
  name: distro.productName,
  executableName: distro.executableName,
  asar: { unpack: '**/node-pty/**' },
  ...(useWindowsX64Checksum
    ? {
        download: {
          checksums: {
            [electronArtifactName]: electronArtifactSha256,
          },
        },
      }
    : {}),
  extraResource: [
    ...(harnessResourceDir ? [harnessResourceDir] : []),
    'src/images',
    'src/pets/assets',
    'src/app-update.yml',
  ],
  icon: 'src/images/icon',
  appBundleId: 'local.codebuddy.desktop',
  appCategoryType: 'public.app-category.developer-tools',
  // Windows specific configuration
  win32: {
    icon: 'src/images/icon.ico',
    certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
    signingRole: process.env.WINDOW_SIGNING_ROLE,
    rfc3161TimeStampServer: 'http://timestamp.digicert.com',
    signWithParams: '/fd sha256 /tr http://timestamp.digicert.com /td sha256',
  },
  // Protocol registration
  protocols: [
    {
      name: `${distro.productName}Protocol`,
      schemes: [distro.protocol],
    },
  ],
  // macOS Info.plist extensions for drag-and-drop support
  extendInfo: {
    LSMinimumSystemVersion: '14.0',
    // Squirrel reads already authenticated and verified ZIP bytes through a
    // loopback-only feed. Public update traffic continues to require HTTPS.
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    // Document types for drag-and-drop support onto dock icon
    CFBundleDocumentTypes: [
      {
        CFBundleTypeName: 'Folders',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.directory', 'public.folder'],
      },
    ],
    // Usage descriptions for macOS TCC (Transparency, Consent, and Control)
    NSMicrophoneUsageDescription: `${distro.productName} needs access to your microphone for voice dictation.`,
    NSLocalNetworkUsageDescription: `${distro.productName} connects to model services and development servers on your local network.`,
    NSAppleEventsUsageDescription: `${distro.productName} needs access to send Apple Events to control other apps on your behalf.`,
    NSScreenCaptureUsageDescription: `${distro.productName} observes application windows for computer-control tasks you request.`,
    NSAccessibilityUsageDescription: `${distro.productName} operates the applications selected for your computer-control tasks.`,
  },
};

const macSigning = targetPlatform === 'darwin' ? signingPlan() : { kind: 'ad-hoc' };
if (macSigning.identity) {
  cfg.osxSign = {
    identity: macSigning.identity,
    continueOnError: false,
    type: macSigning.kind === 'development' ? 'development' : 'distribution',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    keychain: process.env.KEYCHAIN_PATH || undefined,
    // osx-sign 1.3.3 drops array-form ignore; its single predicate form survives validation.
    ignore: ignoreNonMacCode,
    optionsForFile: (file) =>
      macSigningOptionsForFile(file, resolve(__dirname, 'entitlements.plist')),
  };
}
if (macSigning.notarize) {
  cfg.osxNotarize = {
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  };
}

module.exports = {
  packagerConfig: cfg,
  hooks: {
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform) => {
      // Vite omits node_modules on both desktop platforms, including native PTY.
      if (platform === 'darwin' || platform === 'win32') stagePty(buildPath);
    },
    packageAfterPrune: async (_config, buildPath, _electronVersion, platform, arch) => {
      if (platform === 'darwin') preparePty(buildPath, arch);
    },
  },
  // node-pty ships Node-API Windows prebuilds shared by Node and Electron.
  // Rebuilding them needlessly requires a local Visual Studio Spectre toolchain.
  rebuildConfig: {
    ignoreModules:
      (requestedTarget('platform') || process.platform) === 'win32' &&
      fs.existsSync(
        resolve(
          require.resolve('node-pty/package.json'),
          '..',
          'prebuilds',
          'win32-' + (requestedTarget('arch') || process.arch),
          'conpty.node'
        )
      )
        ? ['node-pty']
        : [],
  },
  publishers:
    process.env.GITHUB_OWNER && process.env.GITHUB_REPO
      ? [
          {
            name: '@electron-forge/publisher-github',
            config: {
              repository: {
                owner: process.env.GITHUB_OWNER,
                name: process.env.GITHUB_REPO,
              },
              prerelease: false,
              draft: true,
            },
          },
        ]
      : [],
  makers: [
    // Squirrel uses productName for UI and a no-space config name for the NuGet package.
    // Source: https://www.electronforge.io/config/makers/squirrel.windows
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: harnessResourceDir ? 'CodeBuddyHarness' : 'CodeBuddy',
        authors: 'CodeBuddy',
        description: distro.description,
        exe: `${distro.executableName}.exe`,
        setupExe: 'CodeBuddy-Setup.exe',
        setupIcon: resolve(__dirname, 'src/images/icon.ico'),
        noMsi: true,
        ...(harnessResourceDir && process.env.CODEBUDDY_HARNESS_VENDOR_DIR
          ? { vendorDirectory: process.env.CODEBUDDY_HARNESS_VENDOR_DIR }
          : {}),
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
      config: {
        arch: process.env.ELECTRON_ARCH === 'x64' ? ['x64'] : ['arm64'],
        options: {
          icon: 'src/images/icon.ico',
        },
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        name: distro.productName,
        bin: distro.executableName,
        maintainer: 'CodeBuddy Research Build',
        categories: ['Development'],
        desktopTemplate: './forge.deb.desktop',
        options: {
          icon: 'src/images/icon.png',
          prefix: '/opt',
          ...(isLinuxVulkanBuild ? { depends: ['libvulkan1'] } : {}),
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        name: distro.productName,
        bin: distro.executableName,
        maintainer: 'CodeBuddy Research Build',
        categories: ['Development'],
        desktopTemplate: './forge.rpm.desktop',
        options: {
          icon: 'src/images/icon.png',
          prefix: '/opt',
          ...(isLinuxVulkanBuild ? { requires: ['vulkan-loader'] } : {}),
        },
      },
    },
    {
      name: '@electron-forge/maker-flatpak',
      config: {
        options: {
          id: 'local.codebuddy.desktop',
          categories: ['Development'],
          mimeType: [`x-scheme-handler/${distro.protocol}`],
          icon: {
            scalable: 'src/images/icon.svg',
            '512x512': 'src/images/icon-512.png',
          },
          runtimeVersion: '25.08',
          baseVersion: '25.08',
          bin: distro.executableName,
          modules: [
            {
              name: 'libbz2-shim',
              buildsystem: 'simple',
              'build-commands': [
                // Create the lib directory in the app bundle
                'mkdir -p /app/lib',
                // Point to the actual library in the 25.08 runtime
                // We use a wildcard to handle multi-arch paths (x86_64-linux-gnu, etc)
                'ln -s $(find /usr/lib -name "libbz2.so.1" | head -n 1) /app/lib/libbz2.so.1.0',
              ],
            },
            {
              name: 'git',
              buildsystem: 'simple',
              'build-commands': [
                'mkdir -p /app/bin /app/libexec/git-core',
                'cp /usr/bin/git /app/bin/git',
                'cp /usr/libexec/git-core/git-remote-https /app/libexec/git-core/git-remote-https 2>/dev/null || true',
              ],
            },
          ],
          finishArgs: [
            '--share=ipc',
            '--socket=x11',
            '--socket=wayland',
            '--device=dri',
            '--share=network',
            '--filesystem=home',
            '--talk-name=org.freedesktop.Notifications',
            '--socket=session-bus',
            '--socket=system-bus',
            // This ensures the app looks in our shim folder first
            '--env=LD_LIBRARY_PATH=/app/lib',
            '--env=GIT_EXEC_PATH=/app/libexec/git-core',
          ],
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main.ts',
            config: 'vite.main.config.mts',
          },
          {
            entry: 'src/preload.ts',
            config: 'vite.preload.config.mts',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mts',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
