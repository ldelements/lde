import { defineConfig } from 'rolldown';

// Bundles the task agent and everything it imports into one CommonJS file,
// the form a Node single executable runs.
export default defineConfig({
  input: 'sea/main.ts',
  platform: 'node',
  output: {
    file: 'dist-sea/agent.cjs',
    format: 'cjs',
    codeSplitting: false,
  },
});
