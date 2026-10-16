import { Dataset, Distribution } from '@lde/dataset';
import { DatasetSchema } from './schema.js';
import { type SchemaSearchInterface } from 'ldkit';
import { createLens } from 'ldkit';
import { prepareQuery } from './query.js';
import { Paginator } from './paginator.js';

export type SearchCriteria = SchemaSearchInterface<typeof DatasetSchema>;

export class Client {
  constructor(
    private readonly sparqlEndpoint: URL,
    private readonly schema = DatasetSchema,
  ) {}

  public query(criteria: SearchCriteria): Promise<Paginator<Dataset>>;
  public query(constructQuery: string): Promise<Paginator<Dataset>>;
  public async query(
    args: SearchCriteria | string = {},
  ): Promise<Paginator<Dataset>> {
    const datasets = createLens(this.schema, {
      sources: [this.sparqlEndpoint.toString()],
      // logQuery: (query) => console.debug(query),
    });

    let results;
    let total;
    let pageSize;

    if (typeof args === 'string') {
      // Custom query has no paginated results.
      results = await datasets.query(prepareQuery(args));
      total = results.length;
      pageSize = total;
    } else {
      // With search criteria the results are paginated.
      total = await datasets.count({ where: args });
      pageSize = 1000;
    }

    return new Paginator(
      async (offset: number, limit: number) => {
        let items;
        if (typeof args === 'string') {
          // Custom query has no paginated results.
          // TODO: we could add a convention here like {OFFSET} {LIMIT} in the query string.
          items = await datasets.query(prepareQuery(args));
        } else {
          items = await datasets.find({
            where: args,
            take: limit,
            skip: offset,
          });
        }
        return items.map(
          (dataset) =>
            new Dataset({
              iri: new URL(dataset.$id),
              title: dataset.title,
              description: dataset.description,
              language: dataset.language,
              license: dataset.license ? new URL(dataset.license) : undefined,
              distributions: dataset.distribution.map((d) => {
                const distribution = new Distribution(
                  new URL(d.accessURL),
                  d.mediaType ?? undefined,
                  d.conformsTo ? new URL(d.conformsTo) : undefined,
                );
                distribution.byteSize = d.byteSize ?? undefined;
                distribution.compressFormat = d.compressFormat ?? undefined;
                distribution.lastModified = d.modified ?? undefined;

                return distribution;
              }),
              creator: dataset.creator.map((creator) => ({
                iri: new URL(creator.$id),
                name: creator.name,
              })),
              publisher: dataset.publisher
                ? {
                    iri: new URL(dataset.publisher.$id),
                    name: dataset.publisher.name,
                  }
                : undefined,
            }),
        );
      },
      total,
      pageSize,
    );
  }
}
