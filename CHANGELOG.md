# Changelog

## 1.0.1

- Fix: `GridCell` id generation used `ngeohash`'s `encode`, which breaks
  exact-midpoint ties with `>`. Go (`pierrre/geohash`), Rust (`majortom-rs`)
  and Python (`majortom`) all use `>=`, so any cell whose center latitude or
  longitude landed exactly on a geohash bisection midpoint (a dyadic value)
  got a different ID in this package than in the other implementations.
  `cellFromId` would throw `No cell found with ID …` for valid Go/Rust/Python
  IDs on these cells, and IDs generated here for such cells were rejected by
  the other implementations. Replaced the encoder with a vendored bisection
  implementation that uses `>=`, matching `majortom-rs/src/geohash.rs`.
  Decoding (`ngeohash.decode`) was already tie-independent and needed no
  change. Fixes #1.
- Fix: `cellFromId` now matches IDs case-insensitively. Upper- or mixed-case
  IDs such as `6RR9NJ8P802` used to throw `No cell found with ID …`; they now
  resolve, and the returned cell's `id()` is lowercase.
- Perf: `generateGridCells` no longer runs a full turf intersection test for
  every candidate cell. AOI edges are bucketed by grid row; cells the AOI
  boundary does not touch are classified exactly by a ray cast over that
  row's edges, and only boundary cells fall back to `@turf/boolean-intersects`.
  Output (cell set, order and geometry) is unchanged; a 2000-vertex polygon at
  `d=320` went from ~15 s to ~75 ms.

## 1.0.0

- Initial release.
