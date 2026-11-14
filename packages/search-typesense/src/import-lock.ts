import type { RootType, SearchSchema, SearchType } from '@lde/search';
import { joinGraph } from '@lde/search/adapter';

/** Runs one import, once no import into another collection of its join
 *  component is in flight. */
export type ImportLock = <Result>(
  importBatch: () => Promise<Result>,
) => Promise<Result>;

/**
 * The lock every import into `searchType`’s collection goes through: any
 * number of imports into the same collection run at once, but an import into
 * one collection of a join component waits until no import into another of
 * its collections is in flight. Typesense 30.2 permanently loses an
 * `async_reference` written while the collection it references is being
 * imported (ADR 39), and this excludes that overlap and nothing more.
 *
 * Every writer of a component gets the same lock because it is looked up from
 * the component of the schema the writer was given – so the writers must be
 * given the same {@link SearchSchema}, as `searchIndexWriter` does. A type in
 * no join, or written without a schema, is a component of one, so its imports
 * never wait.
 */
export function importLockFor(
  searchType: SearchType,
  schema: SearchSchema | undefined,
): ImportLock {
  const component =
    schema === undefined
      ? undefined
      : joinGraph(schema).components.find((members) =>
          members.some((member) => member.class === searchType.class),
        );
  let lock = component === undefined ? undefined : locks.get(component);
  if (lock === undefined) {
    lock = new GroupLock();
    if (component !== undefined) {
      locks.set(component, lock);
    }
  }
  const held = lock;
  return (importBatch) => held.run(searchType.name, importBatch);
}

/**
 * Mutual exclusion between groups, concurrency within one: any number of tasks
 * of the group that holds the lock run at once, and a task of another group
 * waits until none is in flight.
 *
 * Waiters are admitted first come, first served, with every waiter of the
 * admitted group let in together: a task of the holding group queues behind
 * an earlier waiter of another group rather than overtaking it, so a busy
 * collection cannot starve the others in its component.
 */
export class GroupLock {
  private holder: string | undefined;
  private inFlight = 0;
  private waiting: { readonly group: string; readonly admit: () => void }[] =
    [];

  /** Run `task` as a member of `group`, once the lock admits that group. */
  async run<Result>(
    group: string,
    task: () => Promise<Result>,
  ): Promise<Result> {
    await this.acquire(group);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(group: string): Promise<void> {
    if (
      this.inFlight === 0 ||
      (this.holder === group && this.waiting.length === 0)
    ) {
      this.holder = group;
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((admit) => this.waiting.push({ group, admit }));
  }

  private release(): void {
    this.inFlight--;
    if (this.inFlight > 0 || this.waiting.length === 0) {
      return;
    }
    const group = this.waiting[0].group;
    const admitted = this.waiting.filter((waiter) => waiter.group === group);
    this.waiting = this.waiting.filter((waiter) => waiter.group !== group);
    this.holder = group;
    this.inFlight = admitted.length;
    for (const waiter of admitted) {
      waiter.admit();
    }
  }
}

/** One lock per join component, held beside the component rather than on
 *  it, as {@link joinGraph} holds its graph beside the schema. */
const locks = new WeakMap<readonly RootType[], GroupLock>();
