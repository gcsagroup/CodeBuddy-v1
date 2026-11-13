// Serialize compatibility loading before linking the SDK implementation.
await import('./windows-process-errors.mjs');
await import('./sdk-budget-contract.mjs');
await import('./windows-acl-contract.mjs');
await import('./tool-error-contract.mjs');
await import('./subagent-return-contract.mjs');
await import('./native-schedule-contract.mjs');
await import('./runtime-context-contract.mjs');
const driver = await import('./driver.mjs');
export const { HARNESS_VERSION, HARNESS_REFERENCE_COMMIT, createHarnessDriver } = driver;
