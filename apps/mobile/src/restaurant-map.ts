// Static restaurant map (M05): projection onto the pre-rendered OpenStreetMap image
// and 2GIS links. No map SDK; see apps/mobile/assets/maps/README.md.

export interface StaticMapMetadata {
  zoom: number;
  /** Image size in points; the asset itself is rendered @3x. */
  width: number;
  height: number;
  pointsPerTilePixel: number;
  /** Top-left image corner in Web Mercator world pixels (256 px tiles) at `zoom`. */
  originWorldPixel: { x: number; y: number };
}
export interface MapPoint {
  x: number;
  y: number;
}

export function worldPixel(latitude: number, longitude: number, zoom: number): MapPoint {
  const scale = 256 * 2 ** zoom;
  const lat = (latitude * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * scale,
    y: ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * scale,
  };
}

/** A coordinate on the image, in the image's own points. */
export function staticMapPoint(
  map: StaticMapMetadata,
  latitude: number,
  longitude: number,
): MapPoint {
  const world = worldPixel(latitude, longitude, map.zoom);
  return {
    x: (world.x - map.originWorldPixel.x) * map.pointsPerTilePixel,
    y: (world.y - map.originWorldPixel.y) * map.pointsPerTilePixel,
  };
}

/** Where an image point lands when the image fills a view with `contentFit="cover"`. */
export function coverPoint(
  map: Pick<StaticMapMetadata, 'width' | 'height'>,
  point: MapPoint,
  viewWidth: number,
  viewHeight: number,
): MapPoint {
  const scale = Math.max(viewWidth / map.width, viewHeight / map.height);
  return {
    x: (viewWidth - map.width * scale) / 2 + point.x * scale,
    y: (viewHeight - map.height * scale) / 2 + point.y * scale,
  };
}

/** `dgis://` deep link for a 2gis.kz/2gis.ru "/geo/<id>" page, or null. */
export function dgisAppUrl(mapUrl: string): string | null {
  const match = /^https:\/\/2gis\.(?:kz|ru)\/(?:[a-z_-]+\/)?geo\/(\d+)(?:[/?#]|$)/.exec(mapUrl);
  return match ? `dgis://2gis.ru/geo/${match[1]}` : null;
}
