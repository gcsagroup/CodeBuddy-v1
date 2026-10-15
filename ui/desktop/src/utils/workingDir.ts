export const getInitialWorkingDir = (): string => {
  const requestedDir = window.appConfig?.get('REQUEST_DIR');
  return typeof requestedDir === 'string' ? requestedDir.trim() : '';
};

export const getHostProcessWorkingDir = (): string => {
  const hostDir = window.appConfig?.get('GOOSE_WORKING_DIR');
  return typeof hostDir === 'string' ? hostDir.trim() : '';
};

export const chooseOrdinaryWorkingDir = async (current: string): Promise<string | null> => {
  const explicit = current.trim();
  if (explicit) return explicit;
  const selection = await window.electron.directoryChooser();
  if (selection.canceled || selection.filePaths.length !== 1) return null;
  const selected = selection.filePaths[0]?.trim();
  return selected || null;
};

export async function runWithOrdinaryWorkingDir<T>(
  current: string,
  operation: (workingDir: string) => Promise<T>
): Promise<{ workingDir: string; value: T } | null> {
  const workingDir = await chooseOrdinaryWorkingDir(current);
  if (!workingDir) return null;
  return { workingDir, value: await operation(workingDir) };
}
