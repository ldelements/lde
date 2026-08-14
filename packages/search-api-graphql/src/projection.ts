import {
  Kind,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLResolveInfo,
  type SelectionSetNode,
} from 'graphql';
import { type ReferenceProjection, type SearchType } from '@lde/search';
import { fieldNamed } from '@lde/search/adapter';

/** How a `lookup` field’s `target` resolves to the Root Type it reads from –
 *  supplied by the caller, which holds the schema. */
export type TargetResolver = (target: string) => SearchType | undefined;

type Fragments = Readonly<Record<string, FragmentDefinitionNode>>;

/**
 * Build the {@link ReferenceProjection} a query’s **selection set** asks for, so
 * the engine fetches each referent’s fields at the depth the client selected and
 * no further. Without it a lookup would either fetch every field of every target
 * at every depth – unbounded, since targets reference one another – or serve
 * fields nothing filled.
 *
 * Only `lookup` references appear: an `idOnly` reference surfaces as its bare
 * IRI, and an `inline` one is already carried by the hit. A selection naming
 * nothing but `id` asks for no `fields`; the id is on the referring document
 * already, so it costs no round-trip.
 *
 * Fragments are followed; `@skip`/`@include` are deliberately **not** evaluated,
 * so a conditionally-skipped selection is fetched and discarded rather than
 * omitted and then missing. Over-fetching a field is recoverable; a null where
 * the client asked for a value is not.
 */
export function projectionFor(
  info: Pick<GraphQLResolveInfo, 'fieldNodes' | 'fragments'>,
  searchType: SearchType,
  targetOf: TargetResolver,
): ReferenceProjection | undefined {
  // `items` carries the hits; the root field’s other selections (pagination,
  // facets) are served without touching a referent.
  const items = info.fieldNodes.flatMap((node) =>
    selectionsNamed(node.selectionSet, 'items', info.fragments),
  );
  const projection = fromSelections(
    items,
    searchType,
    info.fragments,
    targetOf,
  );
  return Object.keys(projection).length === 0 ? undefined : projection;
}

/** The selection sets of every field named `name`, fragments followed. */
function selectionsNamed(
  selectionSet: SelectionSetNode | undefined,
  name: string,
  fragments: Fragments,
): readonly SelectionSetNode[] {
  const found: SelectionSetNode[] = [];
  for (const field of fieldsOf(selectionSet, fragments)) {
    if (field.name.value === name && field.selectionSet !== undefined) {
      found.push(field.selectionSet);
    }
  }
  return found;
}

/** Every field selection in a set, with fragment spreads flattened in place. */
function fieldsOf(
  selectionSet: SelectionSetNode | undefined,
  fragments: Fragments,
): readonly FieldNode[] {
  if (selectionSet === undefined) {
    return [];
  }
  return selectionSet.selections.flatMap((selection) => {
    switch (selection.kind) {
      case Kind.FIELD:
        return [selection];
      case Kind.INLINE_FRAGMENT:
        return fieldsOf(selection.selectionSet, fragments);
      case Kind.FRAGMENT_SPREAD: {
        const fragment = fragments[selection.name.value];
        return fragment === undefined
          ? []
          : fieldsOf(fragment.selectionSet, fragments);
      }
    }
  });
}

/** One level: which lookups were selected, and what each asked for. */
function fromSelections(
  selectionSets: readonly SelectionSetNode[],
  searchType: SearchType,
  fragments: Fragments,
  targetOf: TargetResolver,
): Record<string, { fields?: string[]; resolve?: ReferenceProjection }> {
  const projection: Record<
    string,
    { fields?: string[]; resolve?: ReferenceProjection }
  > = {};
  for (const selectionSet of selectionSets) {
    for (const selected of fieldsOf(selectionSet, fragments)) {
      const field = fieldNamed(searchType, selected.name.value);
      if (
        field === undefined ||
        field.kind !== 'reference' ||
        field.ref?.strategy !== 'lookup'
      ) {
        continue;
      }
      // The target's own declaration decides what its selections mean, so the
      // level below is read against it rather than against this type.
      const target = targetOf(field.ref.target);
      const wanted = fieldsOf(selected.selectionSet, fragments)
        .map((node) => node.name.value)
        .filter((name) => name !== 'id');
      const entry = (projection[selected.name.value] ??= {});
      entry.fields = [...new Set([...(entry.fields ?? []), ...wanted])];
      if (target !== undefined && selected.selectionSet !== undefined) {
        const below = fromSelections(
          [selected.selectionSet],
          target,
          fragments,
          targetOf,
        );
        if (Object.keys(below).length > 0) {
          entry.resolve = { ...entry.resolve, ...below };
        }
      }
    }
  }
  return projection;
}
