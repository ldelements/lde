import { ChildTasks, TaskRunner } from '@lde/task-runner';
import { IncomingMessage, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { json } from 'node:stream/consumers';
import { defaultPort } from './protocol.js';
import type { RunRequest, StopResult, TaskId, TaskResult } from './protocol.js';

export interface HttpTaskRunnerOptions {
  /**
   * Port of the task agent on `127.0.0.1`.
   * @default 7070
   */
  port?: number;
  /**
   * Working directory for the commands, resolved against this process’s
   * working directory. The agent’s container must have it at the same path:
   * mount the volume both containers share at one path in each. Defaults to
   * the agent’s own working directory.
   */
  cwd?: string;
}

/** A task the agent runs. */
export interface HttpTask {
  readonly id: string;
}

/**
 * Runs commands through a task agent in another container of the same pod,
 * such as a sidecar, which then runs them as a `NativeTaskRunner` would. The
 * agent is the `task-agent` executable in `ghcr.io/ldelements/task-runner-http`. The tasks share that container’s memory
 * limit instead of this one’s, so a task that runs out of memory takes down
 * the agent’s container rather than this process.
 *
 * When the agent’s container restarts, its tasks are lost: `wait()` rejects,
 * and `stop()` resolves with `null`. `run()` waits for the restarted agent,
 * for as long as Kubernetes may take to restart it.
 */
export class HttpTaskRunner implements TaskRunner<HttpTask> {
  private readonly origin: string;
  private readonly cwd?: string;
  /** The tasks still going, stopped when this process is told to stop. */
  private readonly childTasks = new ChildTasks<HttpTask>((task) =>
    this.stop(task),
  );

  constructor(options?: HttpTaskRunnerOptions) {
    this.origin = `http://127.0.0.1:${options?.port ?? defaultPort}`;
    this.cwd = options?.cwd === undefined ? undefined : resolve(options.cwd);
  }

  async run(command: string): Promise<HttpTask> {
    const body: RunRequest = { command, cwd: this.cwd };
    const deadline = Date.now() + agentRestartTimeout;
    for (;;) {
      try {
        const response = await this.send('POST', '/tasks', body);
        if (response.statusCode !== 201) {
          throw new Error(
            `The task agent refused to run the command (HTTP ${response.statusCode}): ${JSON.stringify(response.body)}`,
          );
        }
        const task: HttpTask = { id: (response.body as TaskId).id };
        this.childTasks.add(task);
        return task;
      } catch (error) {
        if (!isAgentDown(error) || Date.now() > deadline) {
          throw error;
        }
        // The agent is not up yet, or is restarting.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /** Resolves with the task’s output, or rejects if it failed or was lost. */
  async wait(task: HttpTask): Promise<string> {
    try {
      const response = await this.send('POST', `/tasks/${task.id}/wait`);
      if (response.statusCode === 404) {
        throw new Error(
          `Task ${task.id} is unknown to the task agent, which must have restarted: the task is lost`,
        );
      }
      if (response.statusCode !== 200) {
        throw new Error(
          `The task agent failed to wait for task ${task.id} (HTTP ${response.statusCode}): ${JSON.stringify(response.body)}`,
        );
      }
      const result = response.body as TaskResult;
      if ('error' in result) {
        throw new Error(result.error);
      }
      return result.output;
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw new Error(
          `Lost the task agent while waiting for task ${task.id}: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.childTasks.delete(task);
    }
  }

  /**
   * Stops the task and resolves with its output, or with `null` when the agent
   * no longer has the task: it ended and was waited for, or the agent
   * restarted.
   */
  async stop(task: HttpTask): Promise<string | null> {
    try {
      const response = await this.send('DELETE', `/tasks/${task.id}`);
      if (response.statusCode === 404) {
        return null;
      }
      return (response.body as StopResult).output;
    } catch (error) {
      if (isAgentDown(error)) {
        return null;
      }
      throw error;
    } finally {
      this.childTasks.delete(task);
    }
  }

  private async send(
    method: 'POST' | 'DELETE',
    path: string,
    body?: object,
  ): Promise<{ statusCode: number; body: unknown }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // node:http rather than fetch(), which gives up on a response that takes
    // more than five minutes to start: a task, and so the wait for it, can
    // take hours.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest(
        `${this.origin}${path}`,
        {
          method,
          headers:
            payload === undefined
              ? undefined
              : { 'content-type': 'application/json' },
          // A connection per request: one kept alive outlives an agent that
          // restarts, and the next request on it fails as a reset rather than
          // finding the new agent.
          agent: false,
        },
        resolve,
      );
      outgoing.on('error', reject);
      outgoing.end(payload);
    });
    return { statusCode: response.statusCode!, body: await json(response) };
  }
}

/**
 * How long `run()` keeps trying an agent that refuses connections. Kubernetes
 * restarts a crashed container after a back-off that doubles up to five
 * minutes, so this outlasts the longest back-off.
 */
const agentRestartTimeout = 6 * 60 * 1000;

/**
 * Whether the agent is down: not listening yet, or gone while answering. A
 * request it was answering when it went cannot have left a task behind, as
 * its tasks end with it.
 */
function isAgentDown(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET';
}
