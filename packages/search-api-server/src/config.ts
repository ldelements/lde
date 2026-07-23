/**
 * The server’s complete runtime configuration, read from environment
 * variables ({@link configFromEnvironment}) – the contract of the Docker
 * image. Everything engine- or schema-shaped (query defaults, collection
 * overrides, per-type GraphQL options) lives in the mounted schema module
 * instead, next to the declarations it configures.
 */
export interface ServerConfig {
  /** Path of the mounted schema-declaration module (`SCHEMA_MODULE`). */
  readonly schemaModulePath: string;
  /** TCP port the HTTP server binds (`PORT`). */
  readonly port: number;
  /** Path serving GraphQL, the playground and the SDL (`GRAPHQL_ENDPOINT`). */
  readonly graphqlEndpoint: string;
  /** Serve the playground on GET requests to the endpoint (`PLAYGROUND`). */
  readonly playground: boolean;
  /** Query depth cap (`MAX_DEPTH`); the handler’s default when absent. */
  readonly maxDepth?: number;
  /** Query cost cap (`MAX_COST`); the handler’s default when absent. */
  readonly maxCost?: number;
  /** Where the Typesense engine reads (`TYPESENSE_*`). */
  readonly typesense: TypesenseConnection;
}

/** Connection details of the Typesense node the engine searches. */
export interface TypesenseConnection {
  readonly host: string;
  readonly port: number;
  readonly protocol: 'http' | 'https';
  /** Use a search-only key: the server only ever reads. */
  readonly apiKey: string;
}

/**
 * Read the {@link ServerConfig} from environment variables. Reports **all**
 * problems in one error – a misconfigured deployment learns everything
 * wrong with it from a single boot attempt, not one variable per crash loop.
 */
export function configFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };
  const integer = (name: string, fallback?: number): number | undefined => {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      problems.push(`${name} must be a non-negative integer, got “${value}”`);
      return fallback;
    }
    return parsed;
  };

  const graphqlEndpoint = environment['GRAPHQL_ENDPOINT'] ?? '/graphql';
  if (!graphqlEndpoint.startsWith('/')) {
    problems.push(
      `GRAPHQL_ENDPOINT must be an absolute path, got “${graphqlEndpoint}”`,
    );
  }
  const protocol = environment['TYPESENSE_PROTOCOL'] ?? 'http';
  if (protocol !== 'http' && protocol !== 'https') {
    problems.push(
      `TYPESENSE_PROTOCOL must be “http” or “https”, got “${protocol}”`,
    );
  }

  const config: ServerConfig = {
    schemaModulePath:
      environment['SCHEMA_MODULE'] ?? '/config/search-schema.mjs',
    port: integer('PORT', 4000)!,
    graphqlEndpoint,
    playground: !['false', '0'].includes(
      (environment['PLAYGROUND'] ?? '').toLowerCase(),
    ),
    maxDepth: integer('MAX_DEPTH'),
    maxCost: integer('MAX_COST'),
    typesense: {
      host: required('TYPESENSE_HOST'),
      port: integer('TYPESENSE_PORT', 8108)!,
      protocol: protocol as 'http' | 'https',
      apiKey: required('TYPESENSE_API_KEY'),
    },
  };
  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  }
  return config;
}
