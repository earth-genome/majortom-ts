import geohash from "ngeohash";
import booleanIntersects from "@turf/boolean-intersects";
import { polygon as turfPolygon } from "@turf/helpers";
import type {
  Feature,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

const GEOHASH_PRECISION = 11;
const BASE32_CODES = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Encode a (lat, lon) pair as a geohash of `precision` characters, breaking
 * exact-midpoint ties with `>=` rather than ngeohash's `>`. This matches the
 * bisection rule used by the Go (`pierrre/geohash`), Rust (`majortom-rs`) and
 * Python (`majortom`) reference implementations, so cell IDs agree
 * byte-for-byte even when a cell's center lands exactly on a dyadic midpoint.
 * See https://github.com/earth-genome/majortom-ts/issues/1.
 */
function encodeGeohash(lat: number, lon: number, precision: number): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let isEvenBit = true;
  let bit = 0;
  let charIdx = 0;
  let hash = "";

  while (hash.length < precision) {
    if (isEvenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        charIdx = charIdx * 2 + 1;
        lonMin = mid;
      } else {
        charIdx = charIdx * 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        charIdx = charIdx * 2 + 1;
        latMin = mid;
      } else {
        charIdx = charIdx * 2;
        latMax = mid;
      }
    }
    isEvenBit = !isEvenBit;

    if (++bit === 5) {
      hash += BASE32_CODES[charIdx];
      bit = 0;
      charIdx = 0;
    }
  }
  return hash;
}

/** Accepted area-of-interest geometry inputs. */
export type AOIGeometry =
  | Polygon
  | MultiPolygon
  | Feature<Polygon | MultiPolygon>;

/** Compute the bounding-box center of a GeoJSON Polygon ring. */
function ringCenter(coords: Position[]): [number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

/** Build an axis-aligned rectangular GeoJSON polygon. */
function rectangle(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Extract the underlying geometry from a Feature, if necessary. */
function asGeometry(geom: AOIGeometry): Geometry {
  if ((geom as Feature).type === "Feature") {
    return (geom as Feature).geometry as Geometry;
  }
  return geom as Geometry;
}

/**
 * A single cell in the grid, defined by a GeoJSON Polygon. The cell ID is the
 * 11-character geohash of the cell's center.
 */
export class GridCell {
  readonly geom: Polygon;
  readonly isPrimary: boolean;
  private readonly _id: string;

  constructor(geom: Polygon, isPrimary = true) {
    this.geom = geom;
    this.isPrimary = isPrimary;
    const [lon, lat] = ringCenter(geom.coordinates[0]!);
    this._id = encodeGeohash(lat, lon, GEOHASH_PRECISION);
  }

  /** A geohash string that uniquely identifies the cell. */
  id(): string {
    return this._id;
  }
}

/**
 * An implementation of the ESA Major TOM equal-area grid.
 */
export class MajorTomGrid {
  readonly d: number;
  readonly earthRadius = 6378137;
  readonly overlap: boolean;
  readonly rowCount: number;
  readonly latSpacing: number;
  private readonly latOffset: number;

  constructor(d = 320, overlap = true) {
    if (d <= 0) {
      throw new Error("Grid spacing must be positive");
    }
    this.d = d;
    this.overlap = overlap;
    this.rowCount = Math.max(2, Math.ceil((Math.PI * this.earthRadius) / this.d));
    this.latSpacing = this.getLatSpacing();
    this.latOffset =
      Math.trunc(this.rowCount) % 2 ? this.latSpacing / 2 : 0;
  }

  getLatSpacing(): number {
    return Math.min(180 / this.rowCount, 89);
  }

  getRowLat(rowIdx: number): number {
    return -90 + this.latOffset + rowIdx * this.latSpacing;
  }

  getLonSpacing(lat: number): number {
    const latRad = toRadians(Math.min(Math.max(lat, -89), 89));
    const circumference = 2 * Math.PI * this.earthRadius * Math.cos(latRad);
    const nCols = Math.ceil(circumference / this.d);
    return 360 / Math.max(nCols, 1);
  }

  getLonOffset(lonSpacing: number): number {
    const nCols = lonSpacing > 0 ? Math.round(360 / lonSpacing) : 0;
    return nCols % 2 ? lonSpacing / 2 : 0;
  }

  getColLon(colIdx: number, lonSpacing: number, lonOffset: number): number {
    return -180 + lonOffset + colIdx * lonSpacing;
  }

  /**
   * Divide the area of interest into grid cells and return those that
   * intersect with it.
   */
  generateGridCells(geom: AOIGeometry): GridCell[] {
    const geometry = asGeometry(geom);
    const bounds = boundsOf(geometry);
    let [minLon, minLat, maxLon, maxLat] = bounds;
    if (minLon > maxLon) {
      maxLon += 360;
    }

    let startRow = Math.floor(
      (minLat + 90 - this.latOffset) / this.latSpacing,
    );
    let endRow = Math.ceil((maxLat + 90 - this.latOffset) / this.latSpacing);

    while (this.getRowLat(startRow) > minLat + 1e-10) {
      startRow -= 1;
    }
    while (this.getRowLat(endRow) < maxLat - 1e-10) {
      endRow += 1;
    }

    const cells: GridCell[] = [];

    // Exact fast path for polygonal AOIs; turf decides only boundary cells.
    const parts = polygonParts(geometry);
    const halfLat = this.latSpacing / 2;
    const primaryIndex =
      parts && new BandedEdgeIndex(parts, this.getRowLat(0), this.latSpacing);
    const overlapIndex =
      parts && this.overlap
        ? new BandedEdgeIndex(parts, this.getRowLat(0) + halfLat, this.latSpacing)
        : undefined;

    for (let rowIdx = startRow; rowIdx <= endRow; rowIdx++) {
      const lat = this.getRowLat(rowIdx);
      const lonSpacing = this.getLonSpacing(lat);
      const lonOffset = this.getLonOffset(lonSpacing);

      let startCol = Math.floor((minLon + 180 - lonOffset) / lonSpacing);
      let endCol = Math.ceil((maxLon + 180 - lonOffset) / lonSpacing);

      while (this.getColLon(startCol, lonSpacing, lonOffset) > minLon + 1e-10) {
        startCol -= 1;
      }
      while (this.getColLon(endCol, lonSpacing, lonOffset) < maxLon - 1e-10) {
        endCol += 1;
      }

      for (let colIdx = startCol; colIdx <= endCol; colIdx++) {
        const lon = this.getColLon(colIdx, lonSpacing, lonOffset);
        const maxCellLon = lon + lonSpacing;
        const maxCellLat = lat + this.latSpacing;
        const primaryHit = primaryIndex?.classify(lon, lat, maxCellLon, maxCellLat);
        if (primaryHit !== false) {
          const primary = rectangle(lon, lat, maxCellLon, maxCellLat);
          if (primaryHit || intersects(primary, geometry)) {
            cells.push(new GridCell(primary, true));
          }
        }

        if (this.overlap) {
          const overlapLon = lon + lonSpacing / 2;
          const overlapLat = lat + halfLat;
          const overlapMaxLon = overlapLon + lonSpacing;
          const overlapMaxLat = overlapLat + this.latSpacing;
          const overlapHit = overlapIndex?.classify(
            overlapLon,
            overlapLat,
            overlapMaxLon,
            overlapMaxLat,
          );
          if (overlapHit !== false) {
            const overlapCell = rectangle(
              overlapLon,
              overlapLat,
              overlapMaxLon,
              overlapMaxLat,
            );
            if (overlapHit || intersects(overlapCell, geometry)) {
              cells.push(new GridCell(overlapCell, false));
            }
          }
        }
      }
    }

    return cells;
  }

  /**
   * Retrieve a GridCell from its geohash ID. The row/column index is computed
   * directly from the geohash center coordinates, with a +/-1 neighbor search
   * to handle floating-point edge cases and overlap cells. IDs are matched
   * case-insensitively; the returned cell's `id()` is always lowercase.
   */
  cellFromId(cellId: string): GridCell {
    const searchId = cellId.slice(0, GEOHASH_PRECISION).toLowerCase();
    if (searchId.length !== GEOHASH_PRECISION) {
      throw new Error("Cell ID must be at least 11 characters");
    }

    const { latitude: centerLat, longitude: centerLon } =
      geohash.decode(searchId);

    const halfLat = this.latSpacing / 2;
    for (const rowOffset of [0, -1, 1]) {
      const rowIdx =
        Math.floor((centerLat + 90 - this.latOffset) / this.latSpacing) +
        rowOffset;
      const rowLat = this.getRowLat(rowIdx);
      const lonSpacing = this.getLonSpacing(rowLat);
      const lonOffset = this.getLonOffset(lonSpacing);
      const halfLon = lonSpacing / 2;

      for (const colOffset of [0, -1, 1]) {
        const colIdx =
          Math.floor((centerLon + 180 - lonOffset) / lonSpacing) + colOffset;
        const cellLon = this.getColLon(colIdx, lonSpacing, lonOffset);

        const primary = rectangle(
          cellLon,
          rowLat,
          cellLon + lonSpacing,
          rowLat + this.latSpacing,
        );
        const candidate = new GridCell(primary, true);
        if (candidate.id() === searchId) {
          return candidate;
        }

        if (this.overlap) {
          const overlapLon = cellLon + halfLon;
          const overlapLat = rowLat + halfLat;
          const overlapPoly = rectangle(
            overlapLon,
            overlapLat,
            overlapLon + lonSpacing,
            overlapLat + this.latSpacing,
          );
          const overlapCell = new GridCell(overlapPoly, false);
          if (overlapCell.id() === searchId) {
            return overlapCell;
          }
        }
      }
    }

    throw new Error(`No cell found with ID ${cellId}`);
  }

  /**
   * Map a cell ID from a prior grid version to the current grid. Decodes the
   * geohash to recover the approximate centroid, then returns the current-grid
   * primary cell that contains that point.
   */
  migrateCellId(oldId: string): GridCell {
    const searchId =
      oldId.length > GEOHASH_PRECISION
        ? oldId.slice(0, GEOHASH_PRECISION)
        : oldId;
    if (searchId.length !== GEOHASH_PRECISION) {
      throw new Error("Cell ID must be at least 11 characters");
    }

    const { latitude: lat, longitude: lon } = geohash.decode(searchId);

    const rowIdx = Math.floor((lat + 90 - this.latOffset) / this.latSpacing);
    const rowLat = this.getRowLat(rowIdx);
    const lonSpacing = this.getLonSpacing(rowLat);
    const lonOffset = this.getLonOffset(lonSpacing);
    const colIdx = Math.floor((lon + 180 - lonOffset) / lonSpacing);
    const cellLon = this.getColLon(colIdx, lonSpacing, lonOffset);

    const cellPolygon = rectangle(
      cellLon,
      rowLat,
      cellLon + lonSpacing,
      rowLat + this.latSpacing,
    );
    return new GridCell(cellPolygon, true);
  }
}

/** Compute the [minLon, minLat, maxLon, maxLat] bounds of a geometry. */
function boundsOf(geometry: Geometry): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const visit = (position: Position): void => {
    const [lon, lat] = position;
    if (lon! < minLon) minLon = lon!;
    if (lon! > maxLon) maxLon = lon!;
    if (lat! < minLat) minLat = lat!;
    if (lat! > maxLat) maxLat = lat!;
  };

  const walk = (coords: unknown): void => {
    if (
      Array.isArray(coords) &&
      coords.length > 0 &&
      typeof coords[0] === "number"
    ) {
      visit(coords as Position);
      return;
    }
    if (Array.isArray(coords)) {
      for (const inner of coords) {
        walk(inner);
      }
    }
  };

  if (geometry.type === "GeometryCollection") {
    for (const g of geometry.geometries) {
      const [a, b, c, d] = boundsOf(g);
      if (a < minLon) minLon = a;
      if (b < minLat) minLat = b;
      if (c > maxLon) maxLon = c;
      if (d > maxLat) maxLat = d;
    }
  } else {
    walk((geometry as Exclude<Geometry, GeoJSON.GeometryCollection>).coordinates);
  }

  return [minLon, minLat, maxLon, maxLat];
}

/** Precise polygon/geometry intersection test. */
function intersects(cell: Polygon, geometry: Geometry): boolean {
  return booleanIntersects(turfPolygon(cell.coordinates), geometry);
}

/**
 * Cells are inflated by this many degrees before testing boundary proximity.
 * Anything within this tolerance of the AOI boundary is left to turf.
 */
const BOUNDARY_EPS = 1e-9;

/**
 * Edges of a polygonal AOI bucketed into latitude bands of one grid row, so
 * that each cell only examines the edges that can possibly reach it.
 *
 * A cell that no boundary edge comes near lies entirely inside or entirely
 * outside the AOI, so a ray cast from its center over the band's edges
 * decides the result exactly. Cells that the boundary may touch return
 * `undefined`, and the caller falls back to turf, whose touch/boundary
 * semantics then stay authoritative.
 */
class BandedEdgeIndex {
  /** Flat [x1, y1, x2, y2] per edge. */
  private readonly coords: Float64Array;
  /** Polygon index per edge; rings of one polygon share an index. */
  private readonly parts: Int32Array;
  private readonly buckets = new Map<number, number[]>();
  private readonly parity: Uint8Array;
  private readonly touched: number[] = [];

  constructor(
    polygons: Position[][][],
    private readonly origin: number,
    private readonly spacing: number,
  ) {
    let edgeCount = 0;
    for (const rings of polygons) {
      for (const ring of rings) {
        edgeCount += ring.length;
      }
    }
    this.coords = new Float64Array(edgeCount * 4);
    this.parts = new Int32Array(edgeCount);
    this.parity = new Uint8Array(polygons.length);

    let e = 0;
    for (let p = 0; p < polygons.length; p++) {
      for (const ring of polygons[p]!) {
        const n = ring.length;
        if (n < 2) continue;
        const first = ring[0]!;
        const last = ring[n - 1]!;
        const closed = first[0] === last[0] && first[1] === last[1];
        const segments = closed ? n - 1 : n;
        for (let i = 0; i < segments; i++) {
          const a = ring[i]!;
          const b = ring[(i + 1) % n]!;
          const y1 = a[1]!;
          const y2 = b[1]!;
          this.coords[e * 4] = a[0]!;
          this.coords[e * 4 + 1] = y1;
          this.coords[e * 4 + 2] = b[0]!;
          this.coords[e * 4 + 3] = y2;
          this.parts[e] = p;
          // Pad by one band on each side to absorb floating-point error.
          const lo = this.bandOf(Math.min(y1, y2)) - 1;
          const hi = this.bandOf(Math.max(y1, y2)) + 1;
          for (let band = lo; band <= hi; band++) {
            let bucket = this.buckets.get(band);
            if (!bucket) {
              bucket = [];
              this.buckets.set(band, bucket);
            }
            bucket.push(e);
          }
          e++;
        }
      }
    }
  }

  private bandOf(lat: number): number {
    return Math.floor((lat - this.origin) / this.spacing);
  }

  /**
   * `true` if the cell lies inside the AOI, `false` if outside, `undefined`
   * if the AOI boundary may touch it.
   */
  classify(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
  ): boolean | undefined {
    const cx = (minLon + maxLon) / 2;
    const cy = (minLat + maxLat) / 2;
    const bucket = this.buckets.get(this.bandOf(cy));
    if (!bucket) return false;

    const x0 = minLon - BOUNDARY_EPS;
    const y0 = minLat - BOUNDARY_EPS;
    const x1 = maxLon + BOUNDARY_EPS;
    const y1 = maxLat + BOUNDARY_EPS;
    const { coords, parts, parity, touched } = this;
    let result: boolean | undefined = false;

    for (const e of bucket) {
      const ax = coords[e * 4]!;
      const ay = coords[e * 4 + 1]!;
      const bx = coords[e * 4 + 2]!;
      const by = coords[e * 4 + 3]!;
      if (segmentTouchesRect(ax, ay, bx, by, x0, y0, x1, y1)) {
        result = undefined;
        break;
      }
      // Even-odd ray cast westward from the cell center.
      if (ay > cy !== by > cy) {
        const xCross = ax + ((cy - ay) * (bx - ax)) / (by - ay);
        if (xCross < cx) {
          const p = parts[e]!;
          if (parity[p] === 0) touched.push(p);
          parity[p] ^= 1;
        }
      }
    }

    for (const p of touched) {
      if (parity[p] === 1 && result === false) result = true;
      parity[p] = 0;
    }
    touched.length = 0;
    return result;
  }
}

/**
 * Conservative segment-vs-rectangle overlap via the separating axis theorem
 * (the x and y axes plus the segment normal). Degenerate segments count as
 * touching whenever their bounding boxes overlap.
 */
function segmentTouchesRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1) return false;
  if (Math.max(ay, by) < y0 || Math.min(ay, by) > y1) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return true;
  const tol = BOUNDARY_EPS * len;
  const s00 = dx * (y0 - ay) - dy * (x0 - ax);
  const s10 = dx * (y0 - ay) - dy * (x1 - ax);
  const s01 = dx * (y1 - ay) - dy * (x0 - ax);
  const s11 = dx * (y1 - ay) - dy * (x1 - ax);
  if (s00 > tol && s10 > tol && s01 > tol && s11 > tol) return false;
  if (s00 < -tol && s10 < -tol && s01 < -tol && s11 < -tol) return false;
  return true;
}

/** Polygon parts of a geometry, or `undefined` if it is not polygonal. */
function polygonParts(geometry: Geometry): Position[][][] | undefined {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return undefined;
}
