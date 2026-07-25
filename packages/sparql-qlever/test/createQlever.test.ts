import { describe, expect, it } from 'vitest';
import { createQlever } from '../src/createQlever.js';

describe('createQlever', () => {
  it('addresses the endpoint as localhost by default', () => {
    const { server } = createQlever({
      mode: 'docker',
      image: 'adfreiburg/qlever:latest',
    });
    expect(server.queryEndpoint.toString()).toBe(
      'http://localhost:7001/sparql',
    );
  });

  it('addresses the endpoint as localhost in native mode', () => {
    const { server } = createQlever({ mode: 'native', port: 7002 });
    expect(server.queryEndpoint.toString()).toBe(
      'http://localhost:7002/sparql',
    );
  });

  it('addresses the endpoint by container name on a Docker network', () => {
    const { server } = createQlever({
      mode: 'docker',
      image: 'adfreiburg/qlever:latest',
      network: 'app_default',
      containerName: 'qlever',
    });
    expect(server.queryEndpoint.toString()).toBe('http://qlever:7001/sparql');
  });

  it('rejects a network without a container name at the type level', () => {
    createQlever({
      mode: 'docker',
      image: 'adfreiburg/qlever:latest',
      // @ts-expect-error network requires containerName, the endpoint hostname
      network: 'app_default',
    });
  });
});
