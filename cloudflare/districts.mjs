import data from './districts.json' with { type: 'json' };
import cityData from './city-districts.json' with { type: 'json' };

// OSM district polygons are stored in the repository. No geocoding request occurs during a scan.
export const DISTRICTS = ['Центральный', 'Советский', 'Первомайский', 'Партизанский',
  'Заводской', 'Ленинский', 'Октябрьский', 'Московский', 'Фрунзенский'];
export const CITY_DISTRICTS = Object.fromEntries(Object.entries(cityData)
  .map(([city, districts]) => [city, Object.keys(districts)]));

function insideRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insidePolygon(lon, lat, polygon) {
  return insideRing(lon, lat, polygon[0]) &&
    !polygon.slice(1).some(hole => insideRing(lon, lat, hole));
}

function insideGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return polygons.some(polygon => insidePolygon(lon, lat, polygon));
}

export function matchesDistrict(item, selected) {
  const names = selected?.districts || [];
  if (!names.length) return true;
  const lat = item.latitude, lon = item.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return names.some(name => {
    if (name === 'Партизанский') return insideGeometry(lon, lat, data.city) &&
      !DISTRICTS.filter(x => x !== name).some(x => insideGeometry(lon, lat, data.districts[x]?.geometry));
    const geometry = data.districts[name]?.geometry;
    return insideGeometry(lon, lat, geometry);
  });
}

export function matchesCityDistrict(item, selected, city) {
  const names = selected?.cityDistricts?.[city] || [];
  if (!names.length) return true;
  const lat = item.latitude, lon = item.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return names.some(name => insideGeometry(lon, lat, cityData[city]?.[name]));
}
