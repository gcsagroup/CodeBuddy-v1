// Local-only preview of the candidate renderer; never starts Harness or touches a pet profile.
const path = require('node:path');
async function main() {
  const { createServer, build } = await import('vite');
  const root = path.resolve(__dirname, '..');
  if (process.argv.includes('--export')) {
    const fs = require('node:fs/promises');
    const result = await build({
      root,
      configFile: false,
      publicDir: false,
      build: {
        write: false,
        minify: 'esbuild',
        lib: {
          entry: path.join(root, 'src/pets/prototype/preview.ts'),
          name: 'PandaMotionPreview',
          formats: ['iife'],
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
    const bundle = outputs.find((item) => item.type === 'chunk');
    if (!bundle) throw new Error('Preview bundle was not produced');
    const source = await fs.readFile(path.join(root, 'src/pets/prototype/preview.html'), 'utf8');
    const html = source.replace(
      /<script type="module" src="\.\/preview\.ts"><\/script>/,
      () => `<script>${bundle.code.replace(/<\/script/gi, '<\\/script')}</script>`
    );
    if (html === source) throw new Error('Preview script entry was not found');
    const output = path.join(root, '.local/panda-rig-review/panda-preview.html');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, html);
    process.stdout.write(`${output}\n`);
    return;
  }
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.renderer.config.mts'),
    cacheDir: path.join(root, '.local/panda-rig-vite-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  process.stdout.write(`${server.resolvedUrls.local[0]}src/pets/prototype/preview.html\n`);
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
