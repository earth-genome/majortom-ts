# majortom-eg (TypeScript)

A TypeScript implementation of the ESA [Major TOM](https://github.com/ESA-PhiLab/Major-TOM)
equal-area grid system. This is a port of the
[Python](https://github.com/earth-genome/majortom) and
[Go](https://github.com/earth-genome/mtgrid) implementations and produces
bit-for-bit compatible cell IDs and geometries (validated by a shared
cross-language reference dataset).

## Installation

```console
npm install majortom-eg
```

## Usage

```ts
import { MajorTomGrid } from "majortom-eg";
import type { Polygon } from "geojson";

// generate an overlapping grid with cells of 320m square
const grid = new MajorTomGrid(320, true);

// polygon 1/10 of a degree square
const aoi: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [0, 0.1],
      [0.1, 0.1],
      [0.1, 0],
      [0, 0],
    ],
  ],
};

// iterate over the cells that cover the area
for (const cell of grid.generateGridCells(aoi)) {
  console.log(`cell id is ${cell.id()}`);
  console.log(`cell geom is ${JSON.stringify(cell.geom)}`);
}
```

## API

- `new MajorTomGrid(d = 320, overlap = true)` — create a grid with cell size `d`
  (meters) and optional half-cell overlap. Throws if `d <= 0`.
- `grid.generateGridCells(geom)` — return the `GridCell[]` that intersect a
  GeoJSON `Polygon`, `MultiPolygon`, or `Feature`.
- `grid.cellFromId(id)` — resolve a `GridCell` from its (>=11 char) geohash ID.
- `grid.migrateCellId(oldId)` — map a cell ID from a prior grid version onto the
  current grid, returning the primary cell containing the decoded centroid.
- `GridCell` — has `geom` (GeoJSON `Polygon`), `isPrimary` (boolean), and
  `id()` (11-char geohash string).

## Development

```console
npm install
npm test
```

## License

Distributed under the terms of the [MIT](https://spdx.org/licenses/MIT.html) license.
