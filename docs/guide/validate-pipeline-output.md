# Validate pipeline output with SHACL

This guide shows how to validate the triples a stage generates against [SHACL](https://www.w3.org/TR/shacl/) shapes, and control what happens when validation fails.

## Attach a validator to a stage

Install the validator package alongside `@lde/pipeline`:

```sh
npm install @lde/pipeline-shacl-validator
```

Then attach a `ShaclValidator` to the stage whose output you want to check:

```typescript
import { ShaclValidator } from '@lde/pipeline-shacl-validator';
import { FileWriter, SparqlConstructReader, Stage } from '@lde/pipeline';

new Stage({
  name: 'transform',
  readers: await SparqlConstructReader.fromFile('transform.rq'),
  validation: {
    validator: new ShaclValidator({
      shapesFile: './shapes.ttl',
      reportWriters: [
        new FileWriter({ outputDir: './validation', format: 'turtle' }),
      ],
    }),
    onInvalid: 'write',
  },
});
```

In a stage with an item selector, validation runs on the **combined output of all readers per batch**: each batch is a self-contained cluster of linked resources, so shapes that reference triples from different readers are matched correctly. In a stage without an item selector, the stage’s **entire output** is buffered and validated as one unit – memory then grows with the stage’s whole output, so keep validated selector-less stages small.

## Choose a failure policy

The `onInvalid` option controls what happens to a batch that fails validation:

| `onInvalid` | Behaviour                                          |
| ----------- | -------------------------------------------------- |
| `'write'`   | Write quads even if validation fails **(default)** |
| `'skip'`    | Discard the batch silently                         |
| `'halt'`    | Throw an error, stopping the pipeline              |

Use `'write'` to collect validation reports without interrupting a run, `'skip'` to keep invalid data out of the output, and `'halt'` when invalid output indicates a bug that should stop everything.

## Read the per-dataset report

After all stages for a dataset have run, the pipeline calls the validator’s `report(dataset)` and emits a `datasetValidated` event on the reporter. The report is produced even when no quads were validated – in that case SHACL reports `quadsValidated: 0` and `conforms: true` (the vacuous-truth default). Read `quadsValidated` when you need to distinguish ‘not tested’ from ‘tested and passed’.

## Implement your own validator

`Validator` is an interface, so you can plug in any validation strategy; `ShaclValidator` is the SHACL implementation. See the [@lde/pipeline README](../reference/pipeline#validation) for the full details.
