import { describe, it, expect } from "vitest";
import { MajorTomGrid } from "../src/majortom.js";

const EARTH_RADIUS_KM = 6378.137;
const EARTH_RADIUS_M = 6378137;

function esaLatitudes(distKm: number): number[] {
  const numDivisions = Math.ceil((Math.PI * EARTH_RADIUS_KM) / distKm);
  const step = 180 / numDivisions;
  const lats: number[] = [];
  for (let i = 0; i < numDivisions; i++) {
    let v = -90 + i * step;
    v = ((v % 180) + 180) % 180;
    lats.push(v - 90);
  }
  lats.sort((a, b) => a - b);
  return lats;
}

function esaLongitudes(lat: number, distKm: number): number[] {
  const circumference =
    2 * Math.PI * EARTH_RADIUS_KM * Math.cos((lat * Math.PI) / 180);
  const numDivisions = Math.ceil(circumference / distKm);
  const step = 360 / numDivisions;
  const lons: number[] = [];
  for (let i = 0; i < numDivisions; i++) {
    let v = -180 + i * step;
    v = ((v % 360) + 360) % 360;
    lons.push(v - 180);
  }
  lons.sort((a, b) => a - b);
  return lons;
}

function egLatitudes(grid: MajorTomGrid): number[] {
  const lats: number[] = [];
  for (let i = 0; i < grid.rowCount; i++) {
    lats.push(grid.getRowLat(i));
  }
  return lats;
}

function egLongitudes(grid: MajorTomGrid, lat: number): number[] {
  const lonSpacing = grid.getLonSpacing(lat);
  const lonOffset = grid.getLonOffset(lonSpacing);
  const latRad = (Math.min(Math.max(lat, -89), 89) * Math.PI) / 180;
  const nCols = Math.ceil(
    (2 * Math.PI * EARTH_RADIUS_M * Math.cos(latRad)) / grid.d,
  );
  const lons: number[] = [];
  for (let i = 0; i < nCols; i++) {
    lons.push(grid.getColLon(i, lonSpacing, lonOffset));
  }
  return lons;
}

describe("ESA compatibility", () => {
  it("aligns latitude grid lines with the linspace+mod reference", () => {
    for (const distKm of [5, 10, 50, 100]) {
      const grid = new MajorTomGrid(distKm * 1000, false);
      const esa = esaLatitudes(distKm);
      const eg = egLatitudes(grid);
      expect(eg.length).toBe(esa.length);
      for (let i = 0; i < esa.length; i++) {
        expect(Math.abs(eg[i]! - esa[i]!)).toBeLessThan(1e-10);
      }
    }
  });

  it("aligns longitude grid lines with the linspace+mod reference", () => {
    for (const distKm of [5, 10, 50, 100]) {
      const grid = new MajorTomGrid(distKm * 1000, false);
      for (const testLat of [0.0, 30.0, 45.0, 60.0]) {
        const esa = esaLongitudes(testLat, distKm);
        const eg = egLongitudes(grid, testLat);
        expect(eg.length).toBe(esa.length);
        for (let i = 0; i < esa.length; i++) {
          expect(Math.abs(eg[i]! - esa[i]!)).toBeLessThan(1e-10);
        }
      }
    }
  });

  it("places the equator on a grid line", () => {
    for (const distKm of [5, 7, 10, 13, 50, 100]) {
      const grid = new MajorTomGrid(distKm * 1000, false);
      const lats = egLatitudes(grid);
      expect(lats.some((l) => l === 0.0)).toBe(true);
    }
  });

  it("places the prime meridian on a grid line", () => {
    for (const distKm of [5, 7, 10, 13, 50, 100]) {
      const grid = new MajorTomGrid(distKm * 1000, false);
      for (const testLat of [0.0, 30.0, 60.0]) {
        const lons = egLongitudes(grid, testLat);
        expect(lons.some((l) => l === 0.0)).toBe(true);
      }
    }
  });
});
