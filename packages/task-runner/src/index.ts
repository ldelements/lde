export * from './shell-quote.js';

export interface TaskRunner<Task> {
  run(command: string): Promise<Task>;
  wait(task: Task): Promise<string>;
  stop(task: Task): Promise<string | null>;
}
