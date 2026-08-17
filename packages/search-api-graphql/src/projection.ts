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

/** Whether a type serves this field name – what a projection may ask for. */
function servesField(searchType: SearchType, name: string): boolean {
  return fieldNamed(searchType, name)?.output === true;
}

/** Union two projections level by level, so neither loses what it asked for. */
function mergeProjections(
  left: ReferenceProjection | undefined,
  right: ReferenceProjection,
): ReferenceProjection {
  if (left === undefined) {
    return right;
  }
  const merged: Record<
    string,
    { fields?: readonly string[]; resolve?: ReferenceProjection }
  > = { ...left };
  for (const [name, level] of Object.entries(right)) {
    const existing = merged[name];
    merged[name] =
      existing === undefined
        ? level
        : {
            fields: [
              ...new Set([...(existing.fields ?? []), ...(level.fields ?? [])]),
            ],
            resolve:
              level.resolve === undefined
                ? existing.resolve
                : mergeProjections(existing.resolve, level.resolve),
          };
  }
  return merged;
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
      // Only what the target actually serves. A selection carries more than
      // that: `id` is on the referring document already, and every GraphQL
      // client worth the name injects `__typename` into every selection set –
      // asking the engine for either would fail the query at the port's guard.
      const wanted = fieldsOf(selected.selectionSet, fragments)
        .map((node) => node.name.value)
        .filter((name) =>
          target === undefined ? false : servesField(target, name),
        );
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
          // Merged level by level, not key by key: one lookup selected twice –
          // two fragments each spreading it – must union what each asked for,
          // or the second selection silently replaces the first and a field
          // the client asked for is never fetched.
          entry.resolve = mergeProjections(entry.resolve, below);
        }
      }
    }
  }
  return projection;
}
