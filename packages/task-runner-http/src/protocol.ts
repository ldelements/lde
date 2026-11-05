/** The port the task agent listens on, and the runner sends to, by default. */
export const defaultPort = 7070;

/** Body of `POST /tasks`. */
export interface RunRequest {
  command: string;
  /** Absolute working directory for the command. */
  cwd?: string;
}

/** Response of `POST /tasks`, and the path parameter of the other routes. */
export interface TaskId {
  id: string;
}

/** Response of `POST /tasks/:id/wait`: the task’s output, or why it failed. */
export type TaskResult = { output: string } | { error: string };

/** Response of `DELETE /tasks/:id`: the task’s output. */
export interface StopResult {
  output: string;
}

/** Response of either for a task the agent does not have. */
export interface UnknownTask {
  error: string;
}
