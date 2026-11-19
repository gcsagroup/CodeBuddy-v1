#!/usr/bin/env node
/**
 * Cross-platform i18n compile script.
 * Compiles all JSON message files in src/i18n/messages/ using formatjs.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = path.join(__dirname, '..');
const formatjs = require.resolve('@formatjs/cli/bin/formatjs');
const messagesDir = path.join(projectDir, 'src', 'i18n', 'messages');
const compiledDir = path.join(projectDir, 'src', 'i18n', 'compiled');

fs.mkdirSync(compiledDir, { recursive: true });

// One compiler process validates all locales; starting its bundled CLI once per
// locale adds several seconds to every preview launch on Windows.
execFileSync(
  process.execPath,
  [formatjs, 'compile-folder', messagesDir.split(path.sep).join('/'), compiledDir],
  { stdio: 'inherit', cwd: projectDir }
);
