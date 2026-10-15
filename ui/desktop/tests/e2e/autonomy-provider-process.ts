import { appendFileSync } from 'node:fs';
import { startDeterministicOpenAiServer } from './deterministic-openai-server.ts';

const tracePath = process.argv[2];
if (!tracePath) throw new Error('An explicit local trace file is required');
console.log = (line: string) => appendFileSync(tracePath, `${line}\n`);
const server = await startDeterministicOpenAiServer({ scenario: 'autonomy' });
process.stdout.write(`CODEPRO_MEMORY_PROVIDER_READY ${server.baseUrl}\n`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await new Promise(() => undefined);
