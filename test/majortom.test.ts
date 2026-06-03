import { describe, it, expect } from "vitest";
import booleanIntersects from "@turf/boolean-intersects";
import { polygon as turfPolygon } from "@turf/helpers";
import buffer from "@turf/buffer";
import { point } from "@turf/helpers";
import type { Polygon } from "geojson";
import { MajorTomGrid, GridCell } from "../src/majortom.js";
import { bigSouthampton, southampton } from "./fixtures.js";

function cellsIntersect(geom: Polygon, aoi: Polygon): boolean {
  return booleanIntersects(turfPolygon(geom.coordinates), aoi);
}

function ringsAlmostEqual(a: Polygon, b: Polygon, tol = 1e-8): boolean {
  const ra = a.coordinates[0]!;
  const rb = b.coordinates[0]!;
  if (ra.length !== rb.length) return false;
  for (let i = 0; i < ra.length; i++) {
    if (Math.abs(ra[i]![0] - rb[i]![0]) > tol) return false;
    if (Math.abs(ra[i]![1] - rb[i]![1]) > tol) return false;
  }
  return true;
}

describe("GridCell", () => {
  it("stores a polygon and produces an 11-char geohash id", () => {
    const poly: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
          [-1, -1],
        ],
      ],
    };
    const cell = new GridCell(poly);
    expect(cell.geom.type).toBe("Polygon");
    const id = cell.id();
    expect(typeof id).toBe("string");
    expect(id.length).toBe(11);
  });
});

describe("MajorTomGrid", () => {
  it("rejects non-positive spacing", () => {
    expect(() => new MajorTomGrid(0, true)).toThrow();
    expect(() => new MajorTomGrid(-5, true)).toThrow();
  });

  it("generates 225 intersecting cells for bigSouthampton with overlap", () => {
    const grid = new MajorTomGrid(320, true);
    const cells = grid.generateGridCells(bigSouthampton);
    expect(cells.length).toBe(225);
    for (const cell of cells) {
      expect(cellsIntersect(cell.geom, bigSouthampton)).toBe(true);
    }
  });

  it("produces fewer cells with overlap off than overlap on", () => {
    const withOverlap = new MajorTomGrid(320, true).generateGridCells(
      bigSouthampton,
    );
    const noOverlap = new MajorTomGrid(320, false).generateGridCells(
      bigSouthampton,
    );
    expect(noOverlap.length).toBeLessThan(withOverlap.length);
  });

  it("yields at least one cell for a tiny polygon at the equator", () => {
    const grid = new MajorTomGrid(320, true);
    const tiny = buffer(point([0, 0]), 0.0001, { units: "degrees" });
    expect(tiny).toBeDefined();
    const cells = grid.generateGridCells(tiny!.geometry as Polygon);
    expect(cells.length).toBeGreaterThan(0);
  });

  it("yields cells for a high-latitude polygon", () => {
    const grid = new MajorTomGrid(320, true);
    const poly: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [170, 80],
          [171, 80],
          [171, 81],
          [170, 81],
          [170, 80],
        ],
      ],
    };
    const cells = grid.generateGridCells(poly);
    expect(cells.length).toBeGreaterThan(0);
  });

  it("round-trips every generated cell through cellFromId", () => {
    const grid = new MajorTomGrid(320, true);
    const cells = grid.generateGridCells(southampton);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const found = grid.cellFromId(cell.id());
      expect(found.id()).toBe(cell.id());
      expect(ringsAlmostEqual(found.geom, cell.geom)).toBe(true);
    }
  });

  it("finds a cell that requires the +/-1 neighbor search (edge case)", () => {
    const grid = new MajorTomGrid(320, true);
    const cell = grid.cellFromId("6r32gxpn0w4");
    expect(cell).toBeDefined();
    expect(cell.id()).toBe("6r32gxpn0w4");
    expect(cell.isPrimary).toBe(false);
  });

  it("accepts an over-length id and truncates to 11 chars", () => {
    const grid = new MajorTomGrid(320, true);
    const cell = grid.cellFromId("gcp0yqzxpk4t24vzxu52");
    expect(cell.id()).toBe("gcp0yqzxpk4");
  });

  it("throws when no cell matches the id", () => {
    const grid = new MajorTomGrid(320, true);
    expect(() => grid.cellFromId("short")).toThrow();
  });

  it("produces no duplicate ids for a small (1m) grid", () => {
    const grid = new MajorTomGrid(1, true);
    const aoi: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [-76.34, 39.54],
          [-76.3397, 39.54],
          [-76.3397, 39.5403],
          [-76.34, 39.5403],
          [-76.34, 39.54],
        ],
      ],
    };
    const cells = grid.generateGridCells(aoi);
    expect(cells.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const cell of cells) {
      expect(ids.has(cell.id())).toBe(false);
      ids.add(cell.id());
    }
  });

  it("aligns cells between a smaller and larger overlapping AOI", () => {
    const grid = new MajorTomGrid(320, true);
    const small = grid.generateGridCells(southampton);
    const large = grid.generateGridCells(bigSouthampton);
    for (const cell of small) {
      const found = large.some((c) => ringsAlmostEqual(c.geom, cell.geom));
      expect(found).toBe(true);
    }
  });
});
