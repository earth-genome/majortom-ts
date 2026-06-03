import { describe, it, expect } from "vitest";
import geohash from "ngeohash";
import type { Polygon } from "geojson";
import { MajorTomGrid } from "../src/majortom.js";

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

describe("migrateCellId", () => {
  const oldIds = ["dr18zj1ntew", "dr19n8zgg4e", "s000003037z", "6r32gxpn0w4"];

  it("returns a cell containing the decoded centroid of the old id", () => {
    const grid = new MajorTomGrid(320, true);
    for (const oldId of oldIds) {
      const cell = grid.migrateCellId(oldId);
      const { latitude: lat, longitude: lon } = geohash.decode(oldId);
      const b = boundsOf(cell.geom);
      expect(lon).toBeGreaterThanOrEqual(b.minLon);
      expect(lon).toBeLessThanOrEqual(b.maxLon);
      expect(lat).toBeGreaterThanOrEqual(b.minLat);
      expect(lat).toBeLessThanOrEqual(b.maxLat);
    }
  });

  it("returns a primary cell", () => {
    const grid = new MajorTomGrid(320, true);
    expect(grid.migrateCellId("dr18zj1ntew").isPrimary).toBe(true);
  });

  it("returns a cell with a valid 11-char id", () => {
    const grid = new MajorTomGrid(320, true);
    expect(grid.migrateCellId("dr18zj1ntew").id().length).toBe(11);
  });

  it("throws on an invalid (too short) id", () => {
    const grid = new MajorTomGrid(320, true);
    expect(() => grid.migrateCellId("short")).toThrow();
  });
});
