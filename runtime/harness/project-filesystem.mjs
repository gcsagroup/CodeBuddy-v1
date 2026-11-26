import { FsError } from '@deepseek-ai/dsh-fs';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { projectSandboxPolicy } from './project-sandbox-policy.mjs';

export default class ProjectFileSystem extends SandboxedFileSystem {
  async checkedTarget(target, policy) {
    if (policy) policy = await projectSandboxPolicy(this.ctx, policy);
    const folders = this.ctx.get('codebuddyProjectFolders');
    if (!policy?.sessionId || policy.mode === 'read-only' || !folders)
      return super.checkedTarget(target, policy);
    const fresh = await this.resolve(target.displayPath);
    const root = await folders.writeAccess(policy.workspaceRoot, fresh, policy.sessionId);
    if (root === false)
      throw new FsError('This linked folder is for reference only or its location has changed. Review it in Edit project.', 'FS_PERMISSION_DENIED');
    return super.checkedTarget(fresh, root ? { ...policy, workspaceRoot: root } : policy);
  }
}
