import { NativeTaskRunner } from '@lde/task-runner-native';
import { randomUUID } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import Fastify from 'fastify';
import { defaultPort } from '../src/protocol.js';
import type {
  RunRequest,
  StopResult,
  TaskId,
  TaskResult,
  UnknownTask,
} from '../src/protocol.js';

export interface TaskAgentOptions {
  /**
   * Port to listen on. The agent listens on `127.0.0.1` only, so only
   * processes that share its network namespace – the containers of one
   * Kubernetes pod – can reach it. Pass `0` to have the system pick a free
   * port, which {@link TaskAgent.port} then reports.
   * @default 7070
   */
  port?: number;
}

/** A running task agent. */
export interface TaskAgent {
  /** The port the agent listens on. */
  readonly port: number;
  /**
   * Stops listening. Tasks still going keep running until this process ends,
   * when they are stopped along with it.
   */
  close(): Promise<void>;
}

/**
 * Starts the task agent: an HTTP server on `127.0.0.1` that runs the commands
 * an {@link HttpTaskRunner} sends it, with a {@link NativeTaskRunner}.
 *
 * Anyone who can reach the agent can run any command in its container, which
 * is why it never listens on another address. Reaching it over a network would
 * need authentication and TLS, which the agent does not have.
 */
export async function startTaskAgent(
  options?: TaskAgentOptions,
): Promise<TaskAgent> {
  const tasks = new Map<string, Task>();
  // Closing ends the waits still open too, as the agent’s process ending does,
  // rather than holding the close until their tasks end.
  const server = Fastify({ forceCloseConnections: true });

  // For the container’s startup probe, which runs the agent’s own executable
  // with --probe: kubelet’s own probes connect to the pod’s IP address, and
  // listening there would open the agent to the cluster network.
  server.get('/health', async (request, reply) => reply.code(204).send());

  server.post<{ Body: RunRequest; Reply: TaskId }>(
    '/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['command'],
          additionalProperties: false,
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const runner = new NativeTaskRunner({ cwd: request.body.cwd });
      const process = await runner.run(request.body.command);
      const id = randomUUID();
      tasks.set(id, { runner, process });
      return reply.code(201).send({ id });
    },
  );

  // A POST, not a GET: the agent forgets the task once it has reported how it
  // ended, so the request changes what the agent holds.
  server.post<{ Params: TaskId; Reply: TaskResult | UnknownTask }>(
    '/tasks/:id/wait',
    async (request, reply) => {
      const task = tasks.get(request.params.id);
      if (task === undefined) {
        return reply
          .code(404)
          .send({ error: `Unknown task ${request.params.id}` });
      }
      try {
        return { output: await task.runner.wait(task.process) };
      } catch (error) {
        return { error: (error as Error).message };
      } finally {
        tasks.delete(request.params.id);
      }
    },
  );

  server.delete<{ Params: TaskId; Reply: StopResult | UnknownTask }>(
    '/tasks/:id',
    async (request, reply) => {
      const task = tasks.get(request.params.id);
      if (task === undefined) {
        return reply
          .code(404)
          .send({ error: `Unknown task ${request.params.id}` });
      }
      try {
        return { output: (await task.runner.stop(task.process)) ?? '' };
      } finally {
        tasks.delete(request.params.id);
      }
    },
  );

  await server.listen({
    host: '127.0.0.1',
    port: options?.port ?? defaultPort,
  });

  return {
    port: server.addresses()[0].port,
    close: () => server.close(),
  };
}

/** A task the agent runs, until it has reported how the task ended. */
interface Task {
  runner: NativeTaskRunner;
  process: ChildProcess;
}
