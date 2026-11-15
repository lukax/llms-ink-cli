#!/usr/bin/env node
import { main } from '../src/cli.js';

// Allow inspection to cancel its request and remove a temporary receipt on interruption.
if (process.argv[2] === 'inspect' || (process.argv[2] === 'context' && process.argv[3] === 'inspect')) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try { process.exitCode = await main({signal: controller.signal}); }
  finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
} else process.exitCode = await main();
