// The `tool` command as a library; the executable is bin.ts.
export { buildProgram, run } from './program.js';
export type { Io } from './context.js';
export { bridgeCommand, registerAgent, type Registration } from './agents/register.js';
