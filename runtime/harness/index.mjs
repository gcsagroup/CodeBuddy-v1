// Serialize compatibility loading before linking the SDK implementation.
await import('./sdk-budget-contract.mjs');
await import('./subagent-return-contract.mjs');
const driver = await import('./driver.mjs');
export const { HARNESS_VERSION, HARNESS_REFERENCE_COMMIT, createHarnessDriver } = driver;
