import { NativeTaskRunner } from '@lde/task-runner-native';
import { randomUUID } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
      const oomKillsAtStart = await oomKills();
      const process = await runner.run(request.body.command);
      const id = randomUUID();
      tasks.set(id, { runner, process, oomKillsAtStart });
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
        return { error: await explain(error as Error, task) };
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
  /** The container’s out-of-memory kill count when the task started. */
  oomKillsAtStart: number | undefined;
}

/**
 * The agent’s cgroup, which on cgroup v2 is the container’s own: its memory
 * limit and how often the kernel killed a process for exceeding it.
 */
const cgroup = '/sys/fs/cgroup';

/**
 * Why a task failed, in its words, preceded by the reason when the kernel
 * killed a process in this container for exceeding its memory limit while the
 * task ran. That is the usual reason a task dies here: the agent survives it
 * whenever the kernel kills only the largest process, as Docker has it, while
 * Kubernetes by default kills the whole container, agent included.
 */
async function explain(error: Error, task: Task): Promise<string> {
  const oomKillsNow = await oomKills();
  if (
    task.oomKillsAtStart === undefined ||
    oomKillsNow === undefined ||
    oomKillsNow === task.oomKillsAtStart
  ) {
    return error.message;
  }
  const limit = await memoryLimit();
  return `Ran out of memory: the kernel killed a process in the agent’s container${limit === undefined ? '' : ` at its memory limit of ${limit}`}. ${error.message}`;
}

/** The number of out-of-memory kills in the container, if the system says. */
async function oomKills(): Promise<number | undefined> {
  try {
    const events = await readFile(`${cgroup}/memory.events`, 'utf8');
    const match = /^oom_kill (\d+)$/m.exec(events);
    return match === null ? undefined : Number(match[1]);
  } catch {
    // No cgroup v2 here: not Linux, or not in a container.
    return undefined;
  }
}

/** The container’s memory limit in MiB, if it has one. */
async function memoryLimit(): Promise<string | undefined> {
  const max = (await readFile(`${cgroup}/memory.max`, 'utf8')).trim();
  return max === 'max' ? undefined : `${Math.round(Number(max) / 2 ** 20)} MiB`;
}
