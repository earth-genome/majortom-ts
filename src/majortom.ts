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
    this._id = geohash.encode(lat, lon, GEOHASH_PRECISION);
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
        const primary = rectangle(
          lon,
          lat,
          lon + lonSpacing,
          lat + this.latSpacing,
        );

        if (intersects(primary, geometry)) {
          cells.push(new GridCell(primary, true));
        }

        if (this.overlap) {
          const overlapLon = lon + lonSpacing / 2;
          const overlapLat = lat + this.latSpacing / 2;
          const overlapCell = rectangle(
            overlapLon,
            overlapLat,
            overlapLon + lonSpacing,
            overlapLat + this.latSpacing,
          );
          if (intersects(overlapCell, geometry)) {
            cells.push(new GridCell(overlapCell, false));
          }
        }
      }
    }

    return cells;
  }

  /**
   * Retrieve a GridCell from its geohash ID. The row/column index is computed
   * directly from the geohash center coordinates, with a +/-1 neighbor search
   * to handle floating-point edge cases and overlap cells.
   */
  cellFromId(cellId: string): GridCell {
    const searchId =
      cellId.length > GEOHASH_PRECISION
        ? cellId.slice(0, GEOHASH_PRECISION)
        : cellId;
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
