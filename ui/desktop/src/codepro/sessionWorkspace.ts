import { projectPathIdentity } from '../utils/projectSessions';

interface SessionWorkingDirChange {
  isCodePro: boolean;
  currentWorkingDir: string;
  nextWorkingDir: string;
}

export function shouldUpdateSessionWorkingDir(change: SessionWorkingDirChange): boolean {
  if (
    projectPathIdentity(change.currentWorkingDir) === projectPathIdentity(change.nextWorkingDir)
  ) {
    return false;
  }
  if (change.isCodePro) {
    throw new Error('Start a new CodePro session to use a different project directory');
  }
  return true;
}
