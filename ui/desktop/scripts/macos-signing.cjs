'use strict';

const { spawnSync } = require('node:child_process');

function signingPlan(env = process.env) {
  const identity = env.CODEBUDDY_MAC_SIGN_IDENTITY?.trim();
  if (!identity) {
    if (env.APPLE_TEAM_ID) throw new Error('Set CODEBUDDY_MAC_SIGN_IDENTITY explicitly for a signed build');
    return { kind: 'ad-hoc' };
  }
  const match = /^(Apple Development|Developer ID Application): .+ \(([A-Z0-9]{10})\)$/.exec(identity);
  if (!match) throw new Error('Use the full Apple Development or Developer ID Application identity name');
  const kind = match[1] === 'Apple Development' ? 'development' : 'developer-id';
  // Development certificate common names end in the developer's ID, not the team ID.
  const teamId = kind === 'developer-id' ? match[2] : undefined;
  if (env.APPLE_TEAM_ID && (env.APPLE_TEAM_ID !== teamId || kind !== 'developer-id'))
    throw new Error('Notarization requires a Developer ID Application identity from APPLE_TEAM_ID');
  if (env.APPLE_TEAM_ID && (!env.APPLE_ID || !env.APPLE_ID_PASSWORD))
    throw new Error('macOS notarization requires APPLE_ID and APPLE_ID_PASSWORD with APPLE_TEAM_ID');
  return { kind, identity, teamId, notarize: Boolean(env.APPLE_TEAM_ID) };
}

function parseSignature(output, plan) {
  const field = name => output.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
  const identity = field('Authority');
  const teamId = field('TeamIdentifier');
  const identifier = field('Identifier');
  const requirement = output.match(/^designated => (.+)$/m)?.[1];
  if (!identifier || !requirement) throw new Error('Missing code signing identity or designated requirement');
  if (plan.kind === 'ad-hoc') {
    if (field('Signature') !== 'adhoc') throw new Error('Expected ad-hoc code signature');
  } else if (identity !== plan.identity || !/^[A-Z0-9]{10}$/.test(teamId || '') ||
      (plan.teamId && teamId !== plan.teamId)) {
    throw new Error('Actual code signing certificate or team differs from the selected identity');
  }
  return { identifier, identity: identity || null, teamId: teamId || null, requirement };
}

function inspectSignature(file, plan) {
  const result = spawnSync('codesign', ['-d', '-r-', '--verbose=4', file], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codesign inspection exited with ${result.status}`);
  return parseSignature((result.stdout || '') + '\n' + (result.stderr || ''), plan);
}

module.exports = { signingPlan, parseSignature, inspectSignature };
