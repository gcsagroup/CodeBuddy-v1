export function resolveStartupDirectory(
  args: readonly string[],
  environmentWorkingDirectory?: string
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--dir' || index + 1 >= args.length) continue;
    const commandLineDirectory = args[index + 1]?.trim();
    if (commandLineDirectory) return commandLineDirectory;
  }

  return environmentWorkingDirectory?.trim() || null;
}
