// The task agent’s command line, bundled into a single executable (see
// ../Dockerfile), so it runs in a container that has no Node of its own.
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { startTaskAgent } from './agent.js';

const program = new Command()
  .name('task-agent')
  .description(
    'Run the commands an HttpTaskRunner sends, listening on 127.0.0.1 only.',
  )
  .version(packageJson.version)
  .option('--port <port>', 'port to listen on', '7070')
  .option(
    '--probe',
    'exit with 0 if an agent answers on the port, 1 if not, for a Kubernetes exec probe',
  );

program.parse();
const options = program.opts<{ port: string; probe?: boolean }>();

// No top-level await: a single executable runs a CommonJS bundle. A failure to
// listen rejects unhandled, which ends the process with an error.
if (options.probe) {
  fetch(`http://127.0.0.1:${options.port}/health`).then(
    (response) => process.exit(response.ok ? 0 : 1),
    () => process.exit(1),
  );
} else {
  void startTaskAgent({ port: Number(options.port) }).then((agent) =>
    console.info(
      `@lde/task-runner-http ${packageJson.version}: task agent listening on 127.0.0.1:${agent.port}`,
    ),
  );
}
