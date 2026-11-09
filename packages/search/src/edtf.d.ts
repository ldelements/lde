declare module 'edtf' {
  /** A parsed EDTF value: what it covers, as epoch milliseconds. `min` is
   *  `-Infinity` and `max` `Infinity` for an open bound, `null` for an
   *  unknown one, and both are `NaN` for a year `Date` cannot hold. */
  interface Extended {
    readonly min: number | null;
    readonly max: number | null;
  }

  /** Parse an EDTF string, at most at `level` (default 2); throws on one it
   *  cannot read. */
  export default function edtf(
    value: string,
    options?: { readonly level?: 0 | 1 | 2 },
  ): Extended;
}
