// Project membership is resolved by WorkspaceService; the sandbox only consumes
// its verified roots. Model text cannot extend this allowlist.
export async function projectSandboxPolicy(ctx, policy) {
  const service = ctx.get('codebuddyProjectFolders');
  if (!service?.executionFolders || !policy.sessionId) return policy;
  const folders = await service.executionFolders(policy.workspaceRoot, policy.sessionId);
  if (folders.reference.length && policy.mode === 'danger-full-access') {
    throw new Error('This workspace contains reference-only folders. Full access is unavailable; use workspace-write or read-only.');
  }
  return { ...policy, projectWritableRoots: folders.writable, projectReferenceRoots: folders.reference };
}
