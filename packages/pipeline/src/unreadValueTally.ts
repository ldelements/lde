import type { UnreadValue, ValuesUnread } from './pipelineEvent.js';

/** Distinct examples kept per (target, field). */
const MAX_EXAMPLES = 5;

/**
 * The values a dataset’s stages could not read, tallied per (target, field)
 * for the `valuesUnread` event. Bounded by the schema, not the
 * data: one entry per field that rejected anything, each holding a count and
 * at most {@link MAX_EXAMPLES} distinct examples.
 *
 * Internal to the package: {@link Pipeline} keeps one per dataset.
 */
export class UnreadValueTally {
  private readonly byField = new Map<
    string,
    { target: string; field: string; unread: number; examples: UnreadValue[] }
  >();

  /** Count one value `field` of `target` could not read. */
  add(target: string, field: string, unread: UnreadValue): void {
    // A JSON key cannot collide the way a separator-joined one could.
    const key = JSON.stringify([target, field]);
    let entry = this.byField.get(key);
    if (entry === undefined) {
      entry = { target, field, unread: 0, examples: [] };
      this.byField.set(key, entry);
    }
    entry.unread++;
    if (
      entry.examples.length < MAX_EXAMPLES &&
      !entry.examples.some((example) => example.value === unread.value)
    ) {
      entry.examples.push(unread);
    }
  }

  /** Every field that left values out, in the order it first did. */
  entries(): readonly ValuesUnread[] {
    return [...this.byField.values()];
  }
}
