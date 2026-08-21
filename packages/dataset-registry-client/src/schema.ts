import { dcterms, foaf, ldkit, xsd } from 'ldkit/namespaces';
import { dcat } from './dcat.js';

export const DatasetSchema = {
  '@type': dcat.Dataset,
  title: {
    '@id': dcterms.title,
    '@multilang': true,
  },
  description: {
    '@id': dcterms.description,
    '@optional': true, // But required in DCAT-AP 3.0
    '@multilang': true,
  },
  language: {
    '@id': dcterms.language,
    '@optional': true,
    '@array': true,
  },
  license: {
    '@id': dcterms.license,
    '@type': ldkit.IRI,
    '@optional': true,
  },
  creator: {
    '@id': dcterms.creator,
    '@optional': true, // But required in DCAT-AP 3.0
    '@array': true,
    '@schema': {
      name: {
        '@id': foaf.name,
        '@multilang': true,
      },
    },
  },
  publisher: {
    '@id': dcterms.publisher,
    '@optional': true,
    '@schema': {
      name: {
        '@id': foaf.name,
        '@multilang': true,
      },
    },
  },
  distribution: {
    '@id': dcat.distribution,
    '@array': true,
    '@schema': {
      '@type': dcat.Distribution,
      accessURL: {
        '@id': dcat.accessURL,
        '@type': ldkit.IRI,
      },
      mediaType: {
        '@id': dcat.mediaType,
        '@type': ldkit.IRI,
        '@optional': true,
      },
      byteSize: {
        '@id': dcat.byteSize,
        '@type': xsd.nonNegativeInteger,
        '@optional': true,
      },
      compressFormat: {
        '@id': dcat.compressFormat,
        '@type': ldkit.IRI,
        '@optional': true,
      },
      conformsTo: {
        '@id': dcterms.conformsTo,
        '@type': ldkit.IRI,
        '@optional': true,
      },
      modified: {
        '@id': dcterms.modified,
        '@type': xsd.dateTime,
        '@optional': true,
      },
    },
  },
} as const;
