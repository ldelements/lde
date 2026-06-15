import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
import { Client } from 'typesense';

/**
 * Typesense testcontainer for integration tests, mirroring the QLeverContainer
 * pattern used elsewhere in the NDE stack. Starts a single-node server and
 * hands back a configured client pointed at the mapped port.
 *
 * Image pinned to v30 (per-field stemming + Synonym Sets API; matches consumers).
 */
export class TypesenseContainer {
  public readonly apiKey = 'test-api-key';
  private container: StartedTestContainer | null = null;
  private readonly port = 8108;

  async start(): Promise<Client> {
    this.container = await new GenericContainer('typesense/typesense:30.0')
      .withExposedPorts(this.port)
      .withCommand([
        '--data-dir=/tmp',
        `--api-key=${this.apiKey}`,
        '--enable-cors',
      ])
      .withWaitStrategy(
        Wait.forHttp('/health', this.port).forStatusCode(200),
      )
      .start();
    return this.client();
  }

  client(): Client {
    if (!this.container) {
      throw new Error('Typesense container is not started');
    }
    return new Client({
      nodes: [
        {
          host: this.container.getHost(),
          port: this.container.getMappedPort(this.port),
          protocol: 'http',
        },
      ],
      apiKey: this.apiKey,
      connectionTimeoutSeconds: 5,
    });
  }

  async stop(): Promise<void> {
    if (this.container) {
      await this.container.stop();
      this.container = null;
    }
  }
}
