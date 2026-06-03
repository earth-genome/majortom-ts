import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Polygon } from "geojson";
import { MajorTomGrid, GridCell } from "../src/majortom.js";

const here = dirname(fileURLToPath(import.meta.url));
const testdata = join(here, "..", "testdata");

interface CrossLangCell {
  id: string;
  coords: number[][];
}

interface CrossLangCase {
  count: number;
  cells: CrossLangCell[];
  config: { d: number; overlap: boolean };
  polygon: number[][];
}

function boundsOf(poly: Polygon): {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
} {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of poly.coordinates[0]!) {
    if (lon! < minLon) minLon = lon!;
    if (lon! > maxLon) maxLon = lon!;
    if (lat! < minLat) minLat = lat!;
    if (lat! > maxLat) maxLat = lat!;
  }
  return { minLon, minLat, maxLon, maxLat };
}

describe("cross-language compatibility", () => {
  const raw = readFileSync(
    join(testdata, "cross_language_reference.json"),
    "utf-8",
  );
  const cases = JSON.parse(raw) as Record<string, CrossLangCase>;

  for (const [name, tc] of Object.entries(cases)) {
    it(`matches the reference for ${name}`, () => {
      const ring = tc.polygon.map((pt) => [pt[0]!, pt[1]!]);
      const poly: Polygon = { type: "Polygon", coordinates: [ring] };

      const grid = new MajorTomGrid(tc.config.d, tc.config.overlap);
      const cells = grid.generateGridCells(poly);

      expect(cells.length).toBe(tc.count);

      const byId = new Map<string, GridCell>();
      for (const c of cells) {
        byId.set(c.id(), c);
      }

      for (const refCell of tc.cells) {
        const cell = byId.get(refCell.id);
        expect(cell, `reference id ${refCell.id} missing in output`).toBeDefined();
        const b = boundsOf(cell!.geom);
        const refMinLon = refCell.coords[0]![0]!;
        const refMinLat = refCell.coords[0]![1]!;
        const refMaxLon = refCell.coords[2]![0]!;
        const refMaxLat = refCell.coords[2]![1]!;
        expect(Math.abs(b.minLon - refMinLon)).toBeLessThan(1e-8);
        expect(Math.abs(b.minLat - refMinLat)).toBeLessThan(1e-8);
        expect(Math.abs(b.maxLon - refMaxLon)).toBeLessThan(1e-8);
        expect(Math.abs(b.maxLat - refMaxLat)).toBeLessThan(1e-8);
      }
    });
  }
});

interface GeoJSONFeature {
  geometry: Polygon;
  properties: { cell_id: string };
}
interface GeoJSONFeatureCollection {
  features: GeoJSONFeature[];
}

describe("python output compatibility", () => {
  it("matches python_output.geojson cell geometries and ids", () => {
    const poly: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [-76.33688798683391, 39.56892059705632],
          [-76.33688798683391, 39.54865173376891],
          [-76.30633471133426, 39.54865173376891],
          [-76.30633471133426, 39.56892059705632],
          [-76.33688798683391, 39.56892059705632],
        ],
      ],
    };
    const grid = new MajorTomGrid(320, true);
    const cells = grid.generateGridCells(poly);

    const raw = readFileSync(join(testdata, "python_output.geojson"), "utf-8");
    const fc = JSON.parse(raw) as GeoJSONFeatureCollection;

    expect(cells.length).toBe(fc.features.length);

    const byBounds = (poly: Polygon): string => {
      const b = boundsOf(poly);
      return [b.minLon, b.minLat, b.maxLon, b.maxLat]
        .map((v) => v.toFixed(9))
        .join(",");
    };

    const cellByBounds = new Map<string, GridCell>();
    for (const c of cells) {
      cellByBounds.set(byBounds(c.geom), c);
    }

    for (const feature of fc.features) {
      const key = byBounds(feature.geometry);
      const cell = cellByBounds.get(key);
      expect(cell, `feature ${feature.properties.cell_id} not found`).toBeDefined();
      expect(cell!.id()).toBe(feature.properties.cell_id);
    }
  });
});
