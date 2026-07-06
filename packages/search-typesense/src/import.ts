import type { Client, ImportResponse } from 'typesense';

/**
 * Accumulates documents across writes and upserts them into a collection in
 * fixed-size batches, so many small writes (one dataset at a time) still land
 * as few Typesense requests. Call {@link flush} to import the remainder.
 */
export class BatchImporter<TDocument extends { id: string }> {
  private buffer: TDocument[] = [];

  constructor(
    private readonly client: Client,
    private readonly collection: string,
    private readonly batchSize: number,
  ) {}

  /** Add a stream of documents, importing a batch whenever one fills up. */
  async add(documents: AsyncIterable<TDocument>): Promise<void> {
    for await (const document of documents) {
      this.buffer.push(document);
      if (this.buffer.length >= this.batchSize) {
        await this.importBuffer();
      }
    }
  }

  /** Import any remaining documents. */
  async flush(): Promise<void> {
    if (this.buffer.length > 0) {
      await this.importBuffer();
    }
  }

  private async importBuffer(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    await importBatch(this.client, this.collection, batch);
  }
}

/**
 * Create-or-replace one batch of whole documents, keyed on `id`, throwing if any
 * individual document fails (Typesense’s bulk import otherwise reports
 * per-document failures without rejecting).
 */
export async function importBatch(
  client: Client,
  collection: string,
  batch: readonly { id: string }[],
): Promise<void> {
  const results = (await client
    .collections(collection)
    .documents()
    .import(batch as { id: string }[], {
      action: 'upsert',
      // Collect per-document outcomes instead of throwing the client’s opaque
      // ImportError, so we can report which documents failed and why.
      throwOnFail: false,
    })) as ImportResponse[];
  const failures = results.filter((result) => !result.success);
  if (failures.length > 0) {
    throw new Error(
      `Typesense upsert into “${collection}” failed for ${failures.length}/${results.length} documents: ${failures
        .map((failure) => failure.error)
        .join('; ')}`,
    );
  }
}
