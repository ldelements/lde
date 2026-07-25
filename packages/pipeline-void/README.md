# @lde/pipeline-void

Extensions to [@lde/pipeline](../pipeline) for VoID (Vocabulary of Interlinked Datasets) statistical analysis of RDF datasets.

## Installation

```sh
npm install @lde/pipeline-void
```

## Usage

```typescript
import { voidStages } from '@lde/pipeline-void';
import { Pipeline, SparqlUpdateWriter, provenancePlugin } from '@lde/pipeline';

const stages = await voidStages({ uriSpaces: uriSpaceMap });

await new Pipeline({
  datasetSelector: selector,
  stages,
  plugins: [provenancePlugin()],
  writers: new SparqlUpdateWriter({
    endpoint: new URL('http://localhost:7200/repositories/lde/statements'),
  }),
}).run();
```

## Documentation

See the [full documentation](https://ldelements.org/reference/pipeline-void).
