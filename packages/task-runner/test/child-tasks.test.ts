import { ChildTasks } from '../src/index.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import process from 'node:process';

/** Delivers `signal` to this process as Node does, without the OS. */
function interrupt(signal: NodeJS.Signals): void {
  process.emit(signal, signal);
}

/** Resolves once every promise settled so far has run its continuations. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ChildTasks', () => {
  let listenersBefore: { SIGINT: number; SIGTERM: number };
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listenersBefore = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    // Would end the test process; the exit status is what is asserted.
    exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function listeners() {
    return {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
  }

  it('listens for signals only while a task is going', () => {
    const childTasks = new ChildTasks<string>(() => Promise.resolve());

    childTasks.add('one');
    childTasks.add('two');
    expect(listeners()).toEqual({
      SIGINT: listenersBefore.SIGINT + 1,
      SIGTERM: listenersBefore.SIGTERM + 1,
    });

    childTasks.delete('one');
    expect(listeners()).toEqual({
      SIGINT: listenersBefore.SIGINT + 1,
      SIGTERM: listenersBefore.SIGTERM + 1,
    });

    childTasks.delete('two');
    expect(listeners()).toEqual(listenersBefore);
  });

  it('stops every task and ends the process with the signal’s exit status', async () => {
    const stopped: string[] = [];
    const childTasks = new ChildTasks<string>(async (task) => {
      stopped.push(task);
    });
    childTasks.add('one');
    childTasks.add('two');

    interrupt('SIGINT');
    // No longer listening from the moment the signal arrives, so a second
    // signal ends the process at once, whatever the tasks do.
    expect(listeners()).toEqual(listenersBefore);
    await settled();

    expect(stopped).toEqual(['one', 'two']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    childTasks.delete('one');
    childTasks.delete('two');
  });

  it('exits with the status of the signal it received', async () => {
    const childTasks = new ChildTasks<string>(() => Promise.resolve());
    childTasks.add('one');

    interrupt('SIGTERM');
    await settled();

    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
    childTasks.delete('one');
  });

  it('leaves ending the process to another listener for the signal', async () => {
    const childTasks = new ChildTasks<string>(() => Promise.resolve());
    childTasks.add('one');
    const host = vi.fn();
    process.on('SIGINT', host);
    try {
      interrupt('SIGINT');
      await settled();
    } finally {
      process.off('SIGINT', host);
    }

    expect(host).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    childTasks.delete('one');
  });

  it('ends the process once every runner’s tasks have been stopped', async () => {
    const stopped: string[] = [];
    const quick = new ChildTasks<string>(async (task) => {
      stopped.push(task);
    });
    const slow = new ChildTasks<string>(async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stopped.push(task);
    });
    quick.add('quick');
    slow.add('slow');

    interrupt('SIGINT');
    await settled();
    expect(stopped).toEqual(['quick']);
    expect(exit).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toEqual(['quick', 'slow']);
    expect(exit).toHaveBeenCalledOnce();
    quick.delete('quick');
    slow.delete('slow');
  });

  it('ends the process even when a task could not be stopped', async () => {
    const childTasks = new ChildTasks<string>(() =>
      Promise.reject(new Error('No such container')),
    );
    childTasks.add('one');

    interrupt('SIGINT');
    await settled();

    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    childTasks.delete('one');
  });

  it('answers the signal before a listener the process already had', async () => {
    const order: string[] = [];
    const host = vi.fn(() => {
      order.push('host');
    });
    process.on('SIGINT', host);
    const childTasks = new ChildTasks<string>(async (task) => {
      order.push(`stop ${task}`);
    });
    childTasks.add('one');
    try {
      interrupt('SIGINT');
      await settled();
    } finally {
      process.off('SIGINT', host);
    }

    // What a runner’s stop() does before its first await – sending a process
    // group its SIGTERM – happens even when the host listener ends the process.
    expect(order).toEqual(['stop one', 'host']);
    childTasks.delete('one');
  });

  it('stops a task started while the tasks a signal found are being stopped', async () => {
    const stopped: string[] = [];
    const childTasks = new ChildTasks<string>(async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stopped.push(task);
    });
    childTasks.add('one');

    interrupt('SIGINT');
    await settled();
    childTasks.add('two');
    expect(exit).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stopped).toEqual(['one', 'two']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    childTasks.delete('one');
    childTasks.delete('two');
  });

  it('listens again once a signal the process survived has been answered', async () => {
    const stopped: string[] = [];
    const stop = async (task: string): Promise<void> => {
      stopped.push(task);
    };
    const before = new ChildTasks<string>(stop);
    before.add('one');
    const host = vi.fn();
    process.on('SIGINT', host);
    try {
      interrupt('SIGINT');
      await settled();

      // The host listener let the process live on, and ‘one’ is going still:
      // a task started now must be bound to the process just the same.
      const after = new ChildTasks<string>(stop);
      after.add('two');
      interrupt('SIGINT');
      await settled();
      after.delete('two');
    } finally {
      process.off('SIGINT', host);
    }

    expect(stopped).toEqual(['one', 'one', 'two']);
    expect(exit).not.toHaveBeenCalled();
    before.delete('one');
  });

  it('leaves the listening off when the signal it survived ended the last task', async () => {
    const childTasks = new ChildTasks<string>(() => Promise.resolve());
    childTasks.add('one');
    const host = vi.fn();
    process.on('SIGINT', host);
    try {
      interrupt('SIGINT');
      // The task ends as it is stopped, before the stops have settled.
      childTasks.delete('one');
      await settled();
    } finally {
      process.off('SIGINT', host);
    }

    expect(exit).not.toHaveBeenCalled();
    expect(listeners()).toEqual(listenersBefore);
  });

  it('stops listening once the tasks a signal found have ended', async () => {
    const childTasks = new ChildTasks<string>(() => Promise.resolve());
    childTasks.add('one');
    interrupt('SIGINT');
    await settled();

    childTasks.delete('one');

    expect(listeners()).toEqual(listenersBefore);
  });
});
