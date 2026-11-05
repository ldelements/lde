import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateDocumentation } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHACL_PATH = join(__dirname, 'fixtures', 'shacl.ttl');
const TEMPLATE_PATH = join(__dirname, 'fixtures', 'template.liquid');

describe('Integration tests', () => {
  it('should render template using the built-in default frame', async () => {
    const output = await generateDocumentation(SHACL_PATH, TEMPLATE_PATH);

    expect(output.trim().replace(/ +$/gm, '')).toBe(`name: Dataset
    targetClass: http://www.w3.org/ns/dcat#Dataset
    numOfProperties: 5
        path: http://purl.org/dc/terms/title
        minCount: 1
        severity:
        description:

        path: http://purl.org/dc/terms/alternative
        minCount:
        severity:
        description:
        datatype: xsd:string

        path: http://purl.org/dc/terms/description
        minCount: 1
        severity: Info
        description: Require description to be a multilingual string if it exists
        datatype: rdf:langString, xsd:string

        path: http://purl.org/dc/terms/created
        minCount:
        severity:
        description:
        datatype: xsd:date, xsd:dateTime

        path: http://purl.org/dc/terms/modified
        minCount:
        severity:
        description:
        datatype: xsd:date, xsd:dateTime`);
  });
});
