import { start, StartupError } from './bootstrap.ts';
import { configuration } from './config.ts';

async function main() {
  let config;
  try {
    config = configuration();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid factory configuration.');
    process.exitCode = 1;
    return;
  }
  await start(config).catch((error: unknown) => {
    console.error(error instanceof StartupError ? error.message : 'Factory startup failed.');
    process.exitCode = 1;
  });
}

void main();
