import type { HostLimiter } from '@lde/host-limiter';

/**
 * A limiter that runs every task at once, ignoring pauses, and records the
 * pauses and what each task said about its host.
 */
export function recordingLimiter() {
  const pauses: { host: string; untilMs: number }[] = [];
  const outcomes: ('success' | 'overloaded' | 'ignored')[] = [];
  /** Pauses and settled tasks, in the order they happened. */
  const log: string[] = [];
  const limiter: HostLimiter = {
    async run(_host, task) {
      // As the real limiter reads it: a rejection is overload, and `ignore`
      // wins over both.
      let said: 'overloaded' | 'ignored' | undefined;
      const settle = (outcome: (typeof outcomes)[number]) => {
        outcomes.push(outcome);
        log.push(outcome);
      };
      try {
        const result = await task({
          overloaded: () => {
            said ??= 'overloaded';
          },
          ignore: () => {
            said = 'ignored';
          },
        });
        settle(said ?? 'success');
        return result;
      } catch (error) {
        settle(said === 'ignored' ? 'ignored' : 'overloaded');
        throw error;
      }
    },
    pause(host, untilMs) {
      pauses.push({ host, untilMs });
      log.push('pause');
    },
  };
  return { limiter, pauses, outcomes, log };
}
