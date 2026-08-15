#!/usr/bin/env node
/**
 * Credible — world map generator.
 *
 * Downloads a low-resolution, public-domain world geometry (Natural Earth 110m,
 * distributed as TopoJSON by the `world-atlas` project) and converts it into a
 * plain ES module of SVG path data keyed by ISO 3166-1 alpha-2 country code.
 * The generated module is consumed by the dashboard's MAP tab to draw a
 * choropleth of visitors by country.
 *
 * Everything is implemented here with Node built-ins only: the HTTPS download,
 * the TopoJSON arc decoding, the equirectangular projection, the Douglas-Peucker
 * simplification and the ISO numeric -> alpha-2 lookup table.
 *
 * Usage:
 *   node tools/build-world-map.js                    # download + generate
 *   node tools/build-world-map.js --input topo.json  # use a local TopoJSON file
 *   node tools/build-world-map.js --out other.js     # write somewhere else
 *   node tools/build-world-map.js --tolerance 0.2    # simplification, in px
 *
 * Source data: Natural Earth (public domain, https://www.naturalearthdata.com/),
 * repackaged by world-atlas (ISC). No attribution is legally required for the
 * geometry, but it is credited in the generated file anyway.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { get } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Primary and fallback sources for the 110m TopoJSON world geometry. */
const SOURCES = [
  'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
  'https://raw.githubusercontent.com/topojson/world-atlas/master/countries-110m.json',
  'https://unpkg.com/world-atlas@2/countries-110m.json'
];

/** Output geometry space. Matches WORLD_VIEWBOX in the generated module. */
const WIDTH = 1000;
const HEIGHT = 500;

/**
 * Latitude band kept by the projection, overridable with --lat-top/--lat-bottom.
 *
 * Clipping the poles away is what makes the result look like a normal web map
 * instead of a tall, mostly-empty sheet: +84 sits just above Greenland's
 * northern tip (83.65), and -58 crops the empty Southern Ocean.
 *
 * Note that -58 also drops Antarctica: its northernmost point is the tip of the
 * Antarctic Peninsula at -63.27, so the whole continent lies south of the band
 * and no AQ entry is emitted. That matches how Plausible and most analytics
 * dashboards draw the world. Pass `--lat-bottom -90` for the full continent
 * (a much taller map), or roughly -68 for the peninsula and part of the coast.
 */
let LAT_TOP = 84;
let LAT_BOTTOM = -58;
const LON_MIN = -180;
const LON_MAX = 180;

/** Decimal places kept on projected coordinates (0.01px at 1000px wide). */
const DECIMALS = 2;

/** Rings whose lon/lat bounding box is smaller than this are dropped (degrees). */
const MIN_RING_SPAN = 0.6;

/**
 * Douglas-Peucker tolerance, expressed in output pixels. The source is already
 * a 1:110m generalisation, so this is deliberately tiny: it only removes
 * vertices that are collinear well below one device pixel.
 */
const DEFAULT_TOLERANCE = 0.05;

/**
 * ISO 3166-1 numeric -> alpha-2. world-atlas keys its geometries by the numeric
 * code, while every geolocation database Credible can talk to speaks alpha-2,
 * so the whole standard is embedded here rather than only the codes present in
 * the current file (a newer Natural Earth release may add or split countries).
 */
const NUMERIC_TO_ALPHA2 = {
  '004': 'AF', '008': 'AL', '010': 'AQ', '012': 'DZ', '016': 'AS', '020': 'AD',
  '024': 'AO', '028': 'AG', '031': 'AZ', '032': 'AR', '036': 'AU', '040': 'AT',
  '044': 'BS', '048': 'BH', '050': 'BD', '051': 'AM', '052': 'BB', '056': 'BE',
  '060': 'BM', '064': 'BT', '068': 'BO', '070': 'BA', '072': 'BW', '074': 'BV',
  '076': 'BR', '084': 'BZ', '086': 'IO', '090': 'SB', '092': 'VG', '096': 'BN',
  '100': 'BG', '104': 'MM', '108': 'BI', '112': 'BY', '116': 'KH', '120': 'CM',
  '124': 'CA', '132': 'CV', '136': 'KY', '140': 'CF', '144': 'LK', '148': 'TD',
  '152': 'CL', '156': 'CN', '158': 'TW', '162': 'CX', '166': 'CC', '170': 'CO',
  '174': 'KM', '175': 'YT', '178': 'CG', '180': 'CD', '184': 'CK', '188': 'CR',
  '191': 'HR', '192': 'CU', '196': 'CY', '203': 'CZ', '204': 'BJ', '208': 'DK',
  '212': 'DM', '214': 'DO', '218': 'EC', '222': 'SV', '226': 'GQ', '231': 'ET',
  '232': 'ER', '233': 'EE', '234': 'FO', '238': 'FK', '239': 'GS', '242': 'FJ',
  '246': 'FI', '248': 'AX', '250': 'FR', '254': 'GF', '258': 'PF', '260': 'TF',
  '262': 'DJ', '266': 'GA', '268': 'GE', '270': 'GM', '275': 'PS', '276': 'DE',
  '288': 'GH', '292': 'GI', '296': 'KI', '300': 'GR', '304': 'GL', '308': 'GD',
  '312': 'GP', '316': 'GU', '320': 'GT', '324': 'GN', '328': 'GY', '332': 'HT',
  '334': 'HM', '336': 'VA', '340': 'HN', '344': 'HK', '348': 'HU', '352': 'IS',
  '356': 'IN', '360': 'ID', '364': 'IR', '368': 'IQ', '372': 'IE', '376': 'IL',
  '380': 'IT', '384': 'CI', '388': 'JM', '392': 'JP', '398': 'KZ', '400': 'JO',
  '404': 'KE', '408': 'KP', '410': 'KR', '414': 'KW', '417': 'KG', '418': 'LA',
  '422': 'LB', '426': 'LS', '428': 'LV', '430': 'LR', '434': 'LY', '438': 'LI',
  '440': 'LT', '442': 'LU', '446': 'MO', '450': 'MG', '454': 'MW', '458': 'MY',
  '462': 'MV', '466': 'ML', '470': 'MT', '474': 'MQ', '478': 'MR', '480': 'MU',
  '484': 'MX', '492': 'MC', '496': 'MN', '498': 'MD', '499': 'ME', '500': 'MS',
  '504': 'MA', '508': 'MZ', '512': 'OM', '516': 'NA', '520': 'NR', '524': 'NP',
  '528': 'NL', '531': 'CW', '533': 'AW', '534': 'SX', '535': 'BQ', '540': 'NC',
  '548': 'VU', '554': 'NZ', '558': 'NI', '562': 'NE', '566': 'NG', '570': 'NU',
  '574': 'NF', '578': 'NO', '580': 'MP', '581': 'UM', '583': 'FM', '584': 'MH',
  '585': 'PW', '586': 'PK', '591': 'PA', '598': 'PG', '600': 'PY', '604': 'PE',
  '608': 'PH', '612': 'PN', '616': 'PL', '620': 'PT', '624': 'GW', '626': 'TL',
  '630': 'PR', '634': 'QA', '638': 'RE', '642': 'RO', '643': 'RU', '646': 'RW',
  '652': 'BL', '654': 'SH', '659': 'KN', '660': 'AI', '662': 'LC', '663': 'MF',
  '666': 'PM', '670': 'VC', '674': 'SM', '678': 'ST', '682': 'SA', '686': 'SN',
  '688': 'RS', '690': 'SC', '694': 'SL', '702': 'SG', '703': 'SK', '704': 'VN',
  '705': 'SI', '706': 'SO', '710': 'ZA', '716': 'ZW', '724': 'ES', '728': 'SS',
  '729': 'SD', '732': 'EH', '740': 'SR', '744': 'SJ', '748': 'SZ', '752': 'SE',
  '756': 'CH', '760': 'SY', '762': 'TJ', '764': 'TH', '768': 'TG', '772': 'TK',
  '776': 'TO', '780': 'TT', '784': 'AE', '788': 'TN', '792': 'TR', '795': 'TM',
  '796': 'TC', '798': 'TV', '800': 'UG', '804': 'UA', '807': 'MK', '818': 'EG',
  '826': 'GB', '831': 'GG', '832': 'JE', '833': 'IM', '834': 'TZ', '840': 'US',
  '850': 'VI', '854': 'BF', '858': 'UY', '860': 'UZ', '862': 'VE', '876': 'WF',
  '882': 'WS', '887': 'YE', '894': 'ZM'
};

/**
 * Natural Earth ships a few disputed territories with no ISO numeric code.
 * They are matched on `properties.name` and folded into the alpha-2 code that
 * IP geolocation databases actually report for that territory, so the
 * choropleth has no unpaintable holes.
 */
const NAME_TO_ALPHA2 = {
  Kosovo: 'XK',          // user-assigned code, used by MaxMind, DB-IP and the EU
  'N. Cyprus': 'CY',     // reported as Cyprus by geolocation databases
  Somaliland: 'SO'       // reported as Somalia by geolocation databases
};

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch a URL over HTTPS, following redirects.
 *
 * @param {string} url
 * @param {number} [redirects] Remaining redirect budget.
 * @returns {Promise<string>} Response body.
 */
function fetchText(url, redirects = 5) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = get(url, { headers: { 'user-agent': 'credible-build-world-map' } }, (response) => {
      const { statusCode, headers } = response;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (redirects === 0) {
          rejectPromise(new Error(`Too many redirects for ${url}`));
          return;
        }
        resolvePromise(fetchText(new URL(headers.location, url).href, redirects - 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        rejectPromise(new Error(`HTTP ${statusCode} for ${url}`));
        return;
      }

      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolvePromise(body));
    });

    request.on('error', rejectPromise);
    request.setTimeout(60_000, () => request.destroy(new Error(`Timeout for ${url}`)));
  });
}

/**
 * Try every known source in order and return the first TopoJSON that parses.
 *
 * @returns {Promise<{ topology: object, source: string }>}
 */
async function downloadTopology() {
  const failures = [];

  for (const source of SOURCES) {
    try {
      process.stderr.write(`Downloading ${source}\n`);
      const topology = JSON.parse(await fetchText(source));
      if (topology.type !== 'Topology') throw new Error('Not a TopoJSON topology');
      return { topology, source };
    } catch (error) {
      failures.push(`  ${source}: ${error.message}`);
    }
  }

  throw new Error(`All sources failed:\n${failures.join('\n')}`);
}

/* ------------------------------------------------------------------ */
/* TopoJSON decoding                                                   */
/* ------------------------------------------------------------------ */

/**
 * Decode the topology's delta-encoded, quantized arcs into absolute [lon, lat]
 * positions. TopoJSON stores each arc as a starting position followed by
 * deltas; `transform` maps that integer grid back onto degrees.
 *
 * @param {object} topology
 * @returns {Array<Array<[number, number]>>}
 */
function decodeArcs(topology) {
  const transform = topology.transform;
  const [scaleX, scaleY] = transform ? transform.scale : [1, 1];
  const [translateX, translateY] = transform ? transform.translate : [0, 0];

  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      // Without a transform the arcs are already absolute degrees.
      if (!transform) return [dx, dy];
      x += dx;
      y += dy;
      return [x * scaleX + translateX, y * scaleY + translateY];
    });
  });
}

/**
 * Stitch a ring's arc references into one closed list of positions. A negative
 * index `i` refers to arc `~i` traversed backwards; consecutive arcs share an
 * endpoint, which is dropped on the way in.
 *
 * @param {number[]} ring Arc indices.
 * @param {Array<Array<[number, number]>>} arcs
 * @returns {Array<[number, number]>}
 */
function stitchRing(ring, arcs) {
  const points = [];

  for (const index of ring) {
    const reversed = index < 0;
    const arc = arcs[reversed ? ~index : index];
    const segment = reversed ? arc.slice().reverse() : arc;
    for (let i = points.length === 0 ? 0 : 1; i < segment.length; i += 1) {
      points.push(segment[i]);
    }
  }

  return points;
}

/**
 * Normalise a geometry into a list of polygons, each a list of rings.
 *
 * @param {object} geometry
 * @returns {number[][][]}
 */
function polygonsOf(geometry) {
  if (geometry.type === 'Polygon') return [geometry.arcs];
  if (geometry.type === 'MultiPolygon') return geometry.arcs;
  return [];
}

/* ------------------------------------------------------------------ */
/* Projection and simplification                                       */
/* ------------------------------------------------------------------ */

/**
 * Equirectangular (plate carrée) projection, with the kept latitude band
 * stretched to fill the viewBox height. Latitudes outside the band are clamped
 * rather than clipped, which keeps every ring closed and valid: Antarctica and
 * northern Greenland simply flatten against the map edge.
 *
 * @param {[number, number]} position `[lon, lat]` in degrees.
 * @returns {[number, number]} `[x, y]` in viewBox units.
 */
function project([lon, lat]) {
  const clampedLon = Math.min(LON_MAX, Math.max(LON_MIN, lon));
  const clampedLat = Math.min(LAT_TOP, Math.max(LAT_BOTTOM, lat));
  return [
    ((clampedLon - LON_MIN) / (LON_MAX - LON_MIN)) * WIDTH,
    ((LAT_TOP - clampedLat) / (LAT_TOP - LAT_BOTTOM)) * HEIGHT
  ];
}

/**
 * Remove antimeridian wrap-around from a ring.
 *
 * Natural Earth stores every longitude in -180..180, so a landmass that
 * straddles the 180th meridian (Fiji, the Russian Chukotka, Antarctica's seam)
 * comes through as a ring that suddenly jumps from +179 to -180. Drawn on a
 * flat map that jump becomes a horizontal band across the entire world. Walking
 * the ring and accumulating +/-360 whenever a step exceeds 180 degrees makes the
 * longitudes continuous again, at the cost of leaving the -180..180 range —
 * which `clipToMapRect` then puts back in order.
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>}
 */
function unwrapLongitudes(points) {
  const unwrapped = [];
  let offset = 0;

  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) {
      const step = points[i][0] - points[i - 1][0];
      if (step > 180) offset -= 360;
      else if (step < -180) offset += 360;
    }
    unwrapped.push([points[i][0] + offset, points[i][1]]);
  }

  return unwrapped;
}

/**
 * Clip a polygon against one axis-aligned half-plane (Sutherland-Hodgman).
 *
 * @param {Array<[number, number]>} points Closed ring, without a repeated last point.
 * @param {0 | 1} axis 0 for longitude, 1 for latitude.
 * @param {number} value Position of the clip edge.
 * @param {boolean} keepGreater Keep the side where the coordinate is >= value.
 * @returns {Array<[number, number]>}
 */
function clipHalfPlane(points, axis, value, keepGreater) {
  const other = axis === 0 ? 1 : 0;
  const isInside = (point) => (keepGreater ? point[axis] >= value : point[axis] <= value);
  const intersect = (from, to) => {
    const t = (value - from[axis]) / (to[axis] - from[axis]);
    const point = [0, 0];
    point[axis] = value;
    point[other] = from[other] + t * (to[other] - from[other]);
    return point;
  };

  const output = [];

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const previous = points[(i + points.length - 1) % points.length];
    const currentInside = isInside(current);
    const previousInside = isInside(previous);

    if (currentInside) {
      if (!previousInside) output.push(intersect(previous, current));
      output.push(current);
    } else if (previousInside) {
      output.push(intersect(previous, current));
    }
  }

  return output;
}

/**
 * Clip a ring to the visible lon/lat rectangle. Unlike clamping, this keeps the
 * shape's outline honest: Antarctica gets a straight edge along the bottom
 * parallel instead of a fan of points collapsed onto it.
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>} Empty when the ring is fully outside.
 */
function clipToMapRect(points) {
  let ring = points;
  ring = clipHalfPlane(ring, 0, LON_MIN, true);
  if (ring.length === 0) return ring;
  ring = clipHalfPlane(ring, 0, LON_MAX, false);
  if (ring.length === 0) return ring;
  ring = clipHalfPlane(ring, 1, LAT_BOTTOM, true);
  if (ring.length === 0) return ring;
  return clipHalfPlane(ring, 1, LAT_TOP, false);
}

/**
 * Cut one ring into every piece of it that is actually visible.
 *
 * After unwrapping, a ring may sit partly or wholly outside -180..180, so each
 * 360-degree shift that overlaps the map is clipped and returned separately.
 * That is what makes Fiji appear on both edges of the map rather than as a
 * stripe across it.
 *
 * @param {Array<[number, number]>} points Stitched ring in raw degrees.
 * @returns {Array<Array<[number, number]>>}
 */
function visiblePiecesOf(points) {
  // The stitched ring repeats its first point; Sutherland-Hodgman closes it itself.
  const ring = points.length > 1
    && points[0][0] === points[points.length - 1][0]
    && points[0][1] === points[points.length - 1][1]
    ? points.slice(0, -1)
    : points;

  const unwrapped = unwrapLongitudes(ring);
  const lons = unwrapped.map((point) => point[0]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  const pieces = [];
  const firstShift = Math.floor((LON_MIN - maxLon) / 360);
  const lastShift = Math.ceil((LON_MAX - minLon) / 360);

  for (let shift = firstShift; shift <= lastShift; shift += 1) {
    const offset = shift * 360;
    // Strict overlap: a copy that only touches the edge has no area.
    if (minLon + offset >= LON_MAX || maxLon + offset <= LON_MIN) continue;

    const shifted = offset === 0
      ? unwrapped
      : unwrapped.map(([lon, lat]) => [lon + offset, lat]);

    const clipped = clipToMapRect(shifted);
    if (clipped.length >= 3) pieces.push(clipped);
  }

  return pieces;
}

/**
 * Longitude/latitude bounding box of a ring.
 *
 * @param {Array<[number, number]>} points
 * @returns {{ width: number, height: number }} Span in degrees.
 */
function degreeSpan(points) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return { width: maxLon - minLon, height: maxLat - minLat };
}

/**
 * Perpendicular distance from `point` to the segment `[start, end]`.
 *
 * @param {[number, number]} point
 * @param {[number, number]} start
 * @param {[number, number]} end
 * @returns {number}
 */
function pointSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);

  let t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  t = Math.min(1, Math.max(0, t));

  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

/**
 * Iterative Douglas-Peucker line simplification. Drops vertices that sit closer
 * than `tolerance` to the chord they span, which is invisible at the map's
 * rendered size but removes most of the file's weight.
 *
 * @param {Array<[number, number]>} points
 * @param {number} tolerance
 * @returns {Array<[number, number]>}
 */
function simplify(points, tolerance) {
  if (points.length < 3 || tolerance <= 0) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let furthest = -1;
    let maxDistance = tolerance;

    for (let i = first + 1; i < last; i += 1) {
      const distance = pointSegmentDistance(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthest = i;
      }
    }

    if (furthest !== -1) {
      keep[furthest] = 1;
      stack.push([first, furthest], [furthest, last]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

/**
 * Format a coordinate with at most DECIMALS decimals, trimming trailing zeros
 * (and the negative zero `toFixed` can produce).
 *
 * @param {number} value
 * @returns {string}
 */
function formatCoordinate(value) {
  const text = value.toFixed(DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

/**
 * Convert one projected ring into an SVG subpath, or `null` when the ring
 * collapses to fewer than three distinct points after rounding.
 *
 * @param {Array<[number, number]>} points
 * @returns {string | null}
 */
function ringToSubpath(points) {
  const commands = [];
  let previous = '';

  for (const [x, y] of points) {
    const pair = `${formatCoordinate(x)} ${formatCoordinate(y)}`;
    // Rounding and clamping both create runs of identical points; keep one.
    if (pair === previous) continue;
    commands.push(pair);
    previous = pair;
  }

  // The ring is closed by `Z`, so an explicit repeat of the first point is noise.
  if (commands.length > 1 && commands[0] === commands[commands.length - 1]) commands.pop();
  if (commands.length < 3) return null;

  return `M${commands[0]}L${commands.slice(1).join('L')}Z`;
}

/**
 * Build the full SVG path `d` for one country.
 *
 * @param {object} geometry TopoJSON geometry object.
 * @param {Array<Array<[number, number]>>} arcs Decoded arcs.
 * @param {number} tolerance Simplification tolerance in pixels.
 * @returns {string} Possibly empty when every ring was too small to keep.
 */
function geometryToPath(geometry, arcs, tolerance) {
  const subpaths = [];

  for (const polygon of polygonsOf(geometry)) {
    const rings = [];

    for (let index = 0; index < polygon.length; index += 1) {
      const emitted = [];

      for (const piece of visiblePiecesOf(stitchRing(polygon[index], arcs))) {
        const span = degreeSpan(piece);

        // Drop specks: islands and holes too small to be visible at this scale.
        if (span.width < MIN_RING_SPAN && span.height < MIN_RING_SPAN) continue;

        const subpath = ringToSubpath(simplify(piece.map(project), tolerance));
        if (subpath !== null) emitted.push(subpath);
      }

      // Losing the outer ring means the whole polygon goes, holes included.
      if (emitted.length === 0 && index === 0) {
        rings.length = 0;
        break;
      }

      rings.push(...emitted);
    }

    subpaths.push(...rings);
  }

  return subpaths.join('');
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve a geometry to its ISO 3166-1 alpha-2 code.
 *
 * @param {object} geometry
 * @returns {string | null}
 */
function alpha2Of(geometry) {
  const numeric = geometry.id === undefined || geometry.id === null
    ? null
    : String(geometry.id).padStart(3, '0');

  if (numeric && NUMERIC_TO_ALPHA2[numeric]) return NUMERIC_TO_ALPHA2[numeric];

  const name = geometry.properties && geometry.properties.name;
  return (name && NAME_TO_ALPHA2[name]) || null;
}

/**
 * Render the generated ES module.
 *
 * @param {Record<string, string>} paths alpha-2 -> SVG path data.
 * @param {string} source URL the geometry came from.
 * @returns {string}
 */
function renderModule(paths, source) {
  const codes = Object.keys(paths).sort();
  const entries = codes.map((code) => `  ${code}: '${paths[code]}'`).join(',\n');

  return `/**
 * Credible — world map geometry for the dashboard MAP tab.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node tools/build-world-map.js
 *
 * Geometry: Natural Earth 1:110m Admin 0 countries, which is in the public
 * domain (https://www.naturalearthdata.com/about/terms-of-use/), obtained as
 * TopoJSON from ${source}
 *
 * Projection: equirectangular, clipped to latitudes +${LAT_TOP} / ${LAT_BOTTOM} so the map
 * reads like a normal web map, with that latitude band scaled to fill the
 * ${WIDTH}x${HEIGHT} viewBox. Coordinates are rounded to ${DECIMALS} decimals and rings are
 * simplified; the result is decorative, not survey-grade.
 *
 * Rendering: every path is a closed shape, and countries made of several
 * landmasses concatenate their subpaths, so use \`fill-rule="evenodd"\` to get
 * the interior holes (Lesotho inside South Africa, for example) right.
 *
 *   import { WORLD_VIEWBOX, COUNTRY_PATHS } from './world-map.js';
 *
 *   var svg = '<svg viewBox="' + WORLD_VIEWBOX + '">';
 *   for (var code in COUNTRY_PATHS) {
 *     svg += '<path fill-rule="evenodd" d="' + COUNTRY_PATHS[code] + '"/>';
 *   }
 *
 * ${codes.length} countries and territories, keyed by ISO 3166-1 alpha-2.
 */

/** viewBox for the <svg> element holding COUNTRY_PATHS. */
export const WORLD_VIEWBOX = '0 0 ${WIDTH} ${HEIGHT}';

/** Projection parameters, exposed so callers can place their own markers. */
export const WORLD_PROJECTION = {
  width: ${WIDTH},
  height: ${HEIGHT},
  lonMin: ${LON_MIN},
  lonMax: ${LON_MAX},
  latTop: ${LAT_TOP},
  latBottom: ${LAT_BOTTOM}
};

/**
 * Project a longitude/latitude pair into viewBox coordinates. Latitudes outside
 * the map's band are clamped to its edges.
 *
 * @param {number} lon Longitude in degrees, -180..180.
 * @param {number} lat Latitude in degrees, -90..90.
 * @returns {{ x: number, y: number }}
 */
export function projectPoint(lon, lat) {
  var clampedLon = Math.min(${LON_MAX}, Math.max(${LON_MIN}, lon));
  var clampedLat = Math.min(${LAT_TOP}, Math.max(${LAT_BOTTOM}, lat));
  return {
    x: ((clampedLon - ${LON_MIN}) / ${LON_MAX - LON_MIN}) * ${WIDTH},
    y: ((${LAT_TOP} - clampedLat) / ${LAT_TOP - LAT_BOTTOM}) * ${HEIGHT}
  };
}

/** ISO 3166-1 alpha-2 code -> SVG path data. */
export const COUNTRY_PATHS = {
${entries}
};
`;
}

/**
 * Read `--flag value` style arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    options[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = resolve(ROOT, options.out || 'public/js/world-map.js');
  const tolerance = options.tolerance ? Number(options.tolerance) : DEFAULT_TOLERANCE;

  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`Invalid --tolerance: ${options.tolerance}`);
  }

  if (options['lat-top'] !== undefined) LAT_TOP = Number(options['lat-top']);
  if (options['lat-bottom'] !== undefined) LAT_BOTTOM = Number(options['lat-bottom']);

  if (!Number.isFinite(LAT_TOP) || !Number.isFinite(LAT_BOTTOM) || LAT_BOTTOM >= LAT_TOP) {
    throw new Error(`Invalid latitude band: ${LAT_BOTTOM}..${LAT_TOP}`);
  }

  const { topology, source } = options.input
    ? { topology: JSON.parse(await readFile(resolve(process.cwd(), options.input), 'utf8')), source: options.input }
    : await downloadTopology();

  const collection = topology.objects.countries;
  if (!collection) throw new Error('Topology has no "countries" object');

  const arcs = decodeArcs(topology);
  const paths = {};
  const skipped = [];

  for (const geometry of collection.geometries) {
    const code = alpha2Of(geometry);
    const name = (geometry.properties && geometry.properties.name) || String(geometry.id);

    if (!code) {
      skipped.push(`${name} (id ${geometry.id})`);
      continue;
    }

    const path = geometryToPath(geometry, arcs, tolerance);
    if (path === '') {
      skipped.push(`${name} (nothing visible inside the ${LAT_BOTTOM}..${LAT_TOP} band)`);
      continue;
    }

    // Territories folded into a parent code (N. Cyprus, Somaliland) append.
    paths[code] = (paths[code] || '') + path;
  }

  // Never bake a machine-specific path into the committed file: a local --input
  // is still a copy of the world-atlas release, so credit that instead.
  const credit = options.input ? `a local copy of ${SOURCES[0]}` : source;
  const module = renderModule(paths, credit);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, module, 'utf8');

  const sizeKb = (Buffer.byteLength(module, 'utf8') / 1024).toFixed(1);
  process.stderr.write(`Wrote ${outputPath}\n`);
  process.stderr.write(`  ${Object.keys(paths).length} countries, ${sizeKb} KB, tolerance ${tolerance}px\n`);
  if (skipped.length > 0) process.stderr.write(`  skipped: ${skipped.join(', ')}\n`);
}

main().catch((error) => {
  process.stderr.write(`build-world-map failed: ${error.message}\n`);
  process.exitCode = 1;
});
