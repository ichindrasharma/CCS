#!/usr/bin/env node
// Entry point for the `tool` command. The warning filter must be installed before anything
// imports node:sqlite, so the rest is loaded dynamically after it.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.warn(warning);
});

const { processIo } = await import('./context.js');
const { run } = await import('./program.js');
const code = await run(process.argv.slice(2), processIo());
// `bridge` and `relay start` keep running on their own handles; everything else ends here.
if (code !== 0) process.exit(code);
