import { DataFactory } from 'n3';

const namespace = 'https://w3id.org/lde/content-hash#';

export const contentHashPredicate = DataFactory.namedNode(
  `${namespace}contentHash`,
);
export const hashVersionPredicate = DataFactory.namedNode(
  `${namespace}hashVersion`,
);
