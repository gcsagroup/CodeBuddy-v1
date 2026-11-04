// Request-fit errors are not transport failures. Native compaction owns bounded
// recovery; an invalid caller budget cannot improve through a transport retry.
export const retryPatch = {
  name: '@deepseek-ai/dsh-llm-retry',
  hash: 'cbb99f1c5038e4a9167aedf333343cb3e3adfb5c9f45a37ef7562b024429d050',
  transform(source) {
    source = source.replaceAll('\r\n', '\n');
    const previous = '\tasync function recover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {';
    if (source.split(previous).length !== 2)
      throw new Error('Review the locked request-fit retry ownership patch.');
    return source.replace(previous, previous + '\n\t\tif (failure.code === "LOCAL_OUTPUT_BUDGET_EXHAUSTED" || failure.code === "OUTPUT_TRUNCATED" || failure.code === "OUTPUT_LIMIT_REACHED" || failure.code === "OUTPUT_LENGTH_STOP" || failure.code === "INVALID_OUTPUT_BUDGET") return next();');
  },
};
