import { startDeterministicOpenAiServer } from './deterministic-openai-server.ts';

const server = await startDeterministicOpenAiServer({ scenario: 'project-memory' });
process.stdout.write(`CODEPRO_MEMORY_PROVIDER_READY ${server.baseUrl}\n`);
console.log = () => undefined;

if (process.argv.includes('--probe')) {
  await server.close();
  process.exit(0);
}

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
