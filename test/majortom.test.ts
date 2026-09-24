import { describe, it, expect } from "vitest";
import booleanIntersects from "@turf/boolean-intersects";
import { polygon as turfPolygon } from "@turf/helpers";
import buffer from "@turf/buffer";
import { point } from "@turf/helpers";
import type { MultiPolygon, Polygon } from "geojson";
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

  it("breaks exact geohash midpoint ties upward (>=), matching Go/Rust/Python", () => {
    // Center (0, 0) sits on the first lon and lat bisection midpoints.
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
    expect(new GridCell(poly).id()).toBe("s0000000000");
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

  it("selects exactly the cells turf says intersect holes, notches and overlapping parts", () => {
    const star = (cx: number, cy: number, r: number, n: number): number[][] => {
      const ring: number[][] = [];
      for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * i) / n;
        const rr = r * (i % 2 ? 0.35 : 1);
        ring.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
      }
      ring.push(ring[0]!);
      return ring;
    };
    const hole = star(-76.3, 39.5, 0.012, 40).reverse();
    const aois: (Polygon | MultiPolygon)[] = [
      { type: "Polygon", coordinates: [star(-76.3, 39.5, 0.04, 14), hole] },
      {
        type: "MultiPolygon",
        coordinates: [
          [star(-76.3, 39.5, 0.03, 10)],
          [star(-76.29, 39.505, 0.03, 10)],
        ],
      },
    ];
    const grid = new MajorTomGrid(320, true);
    for (const aoi of aois) {
      // A box with the AOI's exact bounds enumerates the same candidate cells.
      const pts = aoi.coordinates.flat(aoi.type === "Polygon" ? 1 : 2) as number[][];
      const lons = pts.map((p) => p[0]!);
      const lats = pts.map((p) => p[1]!);
      const [x0, x1] = [Math.min(...lons), Math.max(...lons)];
      const [y0, y1] = [Math.min(...lats), Math.max(...lats)];
      const bbox: Polygon = {
        type: "Polygon",
        coordinates: [
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
            [x0, y0],
          ],
        ],
      };
      const expected = grid
        .generateGridCells(bbox)
        .filter((c) => booleanIntersects(turfPolygon(c.geom.coordinates), aoi))
        .map((c) => c.id())
        .sort();
      const actual = grid
        .generateGridCells(aoi)
        .map((c) => c.id())
        .sort();
      expect(actual).toEqual(expected);
    }
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

  it("resolves a cell whose center lon is exactly a geohash midpoint (issue #1)", () => {
    // Reference from Go mtgrid: NewGrid(320, true).CellFromId("6rr9nj8p802").
    const grid = new MajorTomGrid(320, true);
    const cell = grid.cellFromId("6rr9nj8p802");
    expect(cell.id()).toBe("6rr9nj8p802");
    const ring = cell.geom.coordinates[0]!;
    const lons = ring.map((p) => p[0]!);
    const lats = ring.map((p) => p[1]!);
    expect(Math.min(...lons)).toBeCloseTo(-67.94089395491802, 10);
    expect(Math.max(...lons)).toBeCloseTo(-67.93801229508196, 10);
    expect(Math.min(...lats)).toBeCloseTo(-4.012903637931586, 10);
    expect(Math.max(...lats)).toBeCloseTo(-4.010029065125045, 10);

    const aoi: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [-67.9396, -4.0118],
          [-67.9393, -4.0118],
          [-67.9393, -4.0112],
          [-67.9396, -4.0112],
          [-67.9396, -4.0118],
        ],
      ],
    };
    const ids = grid.generateGridCells(aoi).map((c) => c.id());
    expect(ids).toContain("6rr9nj8p802");
    expect(ids).not.toContain("6rr9jvxzxbr");
  });

  it("matches ids case-insensitively and returns the lowercase id", () => {
    const grid = new MajorTomGrid(320, true);
    const cell = grid.cellFromId("6RR9NJ8P802");
    expect(cell.id()).toBe("6rr9nj8p802");
    expect(grid.cellFromId("6Rr9Nj8P802").geom).toEqual(cell.geom);
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
