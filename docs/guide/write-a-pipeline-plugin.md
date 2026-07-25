# Write a pipeline plugin

A plugin post-processes everything a pipeline writes – across all stages, without touching any stage’s own configuration. Use one for cross-cutting concerns: provenance stamping, namespace rewriting, deduplication, cross-stage roll-ups.

## Use the built-in plugins

Register plugins in the `plugins` array; each stage’s output streams through them before it is written:

```typescript
import { provenancePlugin, schemaOrgNormalizationPlugin } from '@lde/pipeline';

new Pipeline({
  // …
  plugins: [schemaOrgNormalizationPlugin(), provenancePlugin()],
});
```

See the [plugins reference](../reference/pipeline#plugins) for what each built-in does.

## Choose the hook

A plugin implements either or both hooks:

- **`beforeStageWrite`** runs once per stage per dataset, over that stage’s merged output. Its context carries the `dataset` and the `stage` name, so it can mint stable per-`(dataset, stage)` IRIs – the home of stage-scoped concerns.
- **`beforeDatasetWrite`** runs once per dataset, over the concatenation of every stage’s output. No stage identity – it sees one whole dataset, so it can reconcile quads that different stages produced. The output streams through a bounded queue; a transform buffers only its own working set.

## Implement your own

A plugin is a named object whose hooks are [quad transforms](./extend-a-stage-with-a-quad-transform) – async generators over the quad stream:

```typescript
import type { PipelinePlugin } from '@lde/pipeline';

const dropEmptyLiterals: PipelinePlugin = {
  name: 'drop-empty-literals',
  beforeStageWrite: async function* (quads) {
    for await (const quad of quads) {
      if (quad.object.termType === 'Literal' && quad.object.value === '') {
        continue;
      }
      yield quad;
    }
  },
};

new Pipeline({
  // …
  plugins: [dropEmptyLiterals],
});
```

For a real `beforeDatasetWrite` example, see `schemaOrgPartitionMergePlugin` in [@lde/pipeline-void](../reference/pipeline-void), which merges VoID partition nodes contributed by different stages.

## Plugin or quad transform?

Attach a [quad transform to a reader](./extend-a-stage-with-a-quad-transform) when the logic belongs to one reader’s output in one stage. Write a plugin when it must apply to everything the pipeline writes. Plugins are quad-only: a projecting pipeline’s output is already the projected document, so the type system forbids them there ([ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)).
