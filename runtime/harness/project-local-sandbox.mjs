import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import { projectSandboxPolicy } from './project-sandbox-policy.mjs';

export default class ProjectLocalSandbox extends LocalSandboxProvider {
  async confine(argv, policy, signal) {
    const resolved = await projectSandboxPolicy(this.ctx, policy);
    const result = await super.confine(argv, resolved, signal);
    if (resolved.mode === 'danger-full-access' || (!resolved.projectWritableRoots?.length && !resolved.projectReferenceRoots?.length)) return result;
    const runner = this.selectRunner(resolved.mode).runner;
    if (runner === 'seatbelt') {
      const args = [...result.argv];
      const profile = args.indexOf('-p') + 1;
      if (!profile) throw Error('Missing Seatbelt profile');
      if (resolved.mode === 'workspace-write' && resolved.projectWritableRoots.length)
        args[profile] += ' (allow file-write* ' + resolved.projectWritableRoots.map(root => `(subpath ${JSON.stringify(root)})`).join(' ') + ')';
      if (resolved.projectReferenceRoots.length)
        args[profile] += ' (deny file-write* ' + resolved.projectReferenceRoots.map(root => `(subpath ${JSON.stringify(root)})`).join(' ') + ')';
      return { ...result, argv: args };
    }
    if (runner === 'bwrap') {
      const args = [...result.argv];
      const separator = args.indexOf('--');
      if (separator < 0) throw Error('Missing Bubblewrap command boundary');
      args.splice(separator, 0,
        ...(resolved.mode === 'workspace-write' ? resolved.projectWritableRoots.flatMap(root => ['--bind', root, root]) : []),
        ...resolved.projectReferenceRoots.flatMap(root => ['--ro-bind', root, root]));
      return { ...result, argv: args };
    }
    throw Error('This sandbox runner does not support multiple writable project folders. No command was started.');
  }
}
