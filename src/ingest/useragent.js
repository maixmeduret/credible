/**
 * User-Agent parsing.
 *
 * Deliberately small: a handful of ordered regexes over the raw header, no
 * lookup tables, no dependency, no network. We only extract what the dashboard
 * actually displays — browser + major version, OS + version, and a coarse
 * device class — because anything finer is fingerprinting material we do not
 * want to store.
 *
 * Order is the whole trick. Nearly every modern browser lies about being some
 * other browser (Chrome claims Safari, Edge claims Chrome, Samsung Internet
 * claims both), so the checks run from the most specific token to the most
 * generic one and the first hit wins.
 *
 * Unknown input never throws: the returned shape is always complete, with ''
 * for anything we could not identify and 'Desktop' as the device fallback.
 */

/** Cap on how much of the header we look at — real UAs are far shorter. */
const MAX_UA_LENGTH = 512;

/** "Windows NT <x>" is a kernel version, not the marketing name people expect. */
const WINDOWS_NT_NAMES = {
  '10.0': '10', // Windows 11 also reports 10.0 and is indistinguishable here
  '6.4': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
  '6.0': 'Vista',
  '5.2': 'XP',
  '5.1': 'XP',
  '5.0': '2000',
};

/** First capture group of `re`, or '' when it does not match. */
function first(ua, re) {
  const m = re.exec(ua);
  return m && m[1] ? m[1] : '';
}

/** '126.0.6478.127' -> '126'. */
function majorOf(version) {
  const m = /(\d+)/.exec(version || '');
  return m ? m[1] : '';
}

/** '10_15_7' / '10.15.7' -> '10.15'. Keeps at most major.minor. */
function majorMinorOf(version) {
  const parts = String(version || '')
    .replace(/_/g, '.')
    .split('.')
    .filter((p) => /^\d+$/.test(p));
  if (parts.length === 0) return '';
  return parts.slice(0, 2).join('.');
}

/**
 * Operating system and version.
 * Android and Chrome OS both carry "Linux", and iOS carries "like Mac OS X",
 * so the specific platforms are tested before the generic ones.
 */
function detectOs(ua) {
  // Consoles first: the Xbox UA is a Windows UA with an extra token.
  if (/\bXbox\b/i.test(ua)) {
    return { os: 'Xbox', osVersion: '' };
  }
  if (/PlayStation/i.test(ua)) {
    // Console generation for the consoles, system version for the Vita.
    return { os: 'Playstation', osVersion: first(ua, /PlayStation (?:Vita )?(\d+)/i) };
  }

  // Windows 10 Mobile adds an "Android x.y" compatibility token, so it has to
  // be tested before Android.
  if (/Windows Phone/i.test(ua)) {
    // '10.0' -> '10' so phones line up with the NT marketing names below.
    const version = majorMinorOf(first(ua, /Windows Phone(?: OS)? ([\d.]+)/i)).replace(/\.0$/, '');
    return { os: 'Windows', osVersion: version };
  }

  if (/\bAndroid\b/i.test(ua)) {
    return { os: 'Android', osVersion: majorMinorOf(first(ua, /Android[\s/]([\d._]+)/i)) };
  }

  if (/\b(?:iPhone|iPad|iPod)\b/i.test(ua) || /\biOS\b/.test(ua)) {
    const version =
      first(ua, /\bOS[\s_]([\d._]+)\s+like Mac OS X/i) ||
      first(ua, /\biOS[\s/]([\d._]+)/i) ||
      first(ua, /\bVersion\/([\d.]+)/i);
    return { os: 'iOS', osVersion: majorMinorOf(version) };
  }

  if (/Windows NT/i.test(ua)) {
    const nt = first(ua, /Windows NT ([\d.]+)/i);
    return { os: 'Windows', osVersion: WINDOWS_NT_NAMES[nt] || '' };
  }
  if (/\bWindows\b/i.test(ua)) {
    return { os: 'Windows', osVersion: '' };
  }

  // iPadOS 13+ Safari claims "Macintosh"; without touch-point hints from the
  // client that is reported as a macOS desktop, which is accepted here.
  if (/Mac OS X|Macintosh|\bmacOS\b/i.test(ua)) {
    return { os: 'macOS', osVersion: majorMinorOf(first(ua, /Mac OS X[\s_]([\d._]+)/i)) };
  }

  if (/\bCrOS\b/.test(ua)) {
    return { os: 'Chrome OS', osVersion: majorMinorOf(first(ua, /CrOS \S+ ([\d.]+)/)) };
  }
  if (/Ubuntu/i.test(ua)) {
    return { os: 'Ubuntu', osVersion: majorMinorOf(first(ua, /Ubuntu[\s/]([\d.]+)/i)) };
  }
  if (/Fedora/i.test(ua)) {
    return { os: 'Fedora', osVersion: majorMinorOf(first(ua, /Fedora[\s/]([\d.]+)/i)) };
  }
  if (/FreeBSD/i.test(ua)) {
    return { os: 'FreeBSD', osVersion: '' };
  }
  if (/\bLinux\b|\bX11\b/i.test(ua)) {
    return { os: 'Linux', osVersion: '' };
  }

  return { os: '', osVersion: '' };
}

/** Coarse device class. Never empty — anything unrecognised counts as Desktop. */
function detectDevice(ua, os) {
  // Consoles are counted with the big screens.
  if (os === 'Playstation' || os === 'Xbox') return 'Desktop';

  if (/\biPad\b/i.test(ua)) return 'Tablet';
  if (/\b(?:iPhone|iPod)\b/i.test(ua)) return 'Mobile';

  // On Android the "Mobile" token is the only reliable phone/tablet signal.
  if (os === 'Android') return /\bMobile\b/i.test(ua) ? 'Mobile' : 'Tablet';

  if (/\bTablet\b|PlayBook|\bKindle\b|Silk\//i.test(ua)) return 'Tablet';
  if (/Windows Phone|IEMobile|Opera Mini|Opera Mobi|BlackBerry|\bBB10\b|webOS|Mobile Safari|\bMobi\b/i.test(ua)) {
    return 'Mobile';
  }
  return 'Desktop';
}

/** Browser name and major version. */
function detectBrowser(ua, os) {
  const chromeVersion = majorOf(first(ua, /(?:Chrome|Chromium|CriOS|CrMo)\/([\d.]+)/i));
  const webkitVersion = majorOf(first(ua, /\bVersion\/([\d.]+)/i));

  // Trident/MSIE: must precede everything, IE11 has neither "MSIE" nor a name.
  if (/Trident\/|\bMSIE\b/i.test(ua)) {
    return { browser: 'Internet Explorer', browserVersion: majorOf(first(ua, /(?:MSIE |rv:)([\d.]+)/i)) };
  }

  // Chromium forks, most specific token first — all of them also say "Chrome".
  if (/\bEdg(?:e|A|iOS)?\//i.test(ua)) {
    return { browser: 'Edge', browserVersion: majorOf(first(ua, /\bEdg(?:e|A|iOS)?\/([\d.]+)/i)) };
  }
  if (/\bOPR\/|\bOPiOS\/|Opera Mini|Opera Mobi|\bOpera\b/i.test(ua)) {
    // Presto-era Opera froze the product token at 9.80 and put the real
    // version in "Version/"; every later build uses OPR/OPiOS.
    const version =
      first(ua, /\bOPR\/([\d.]+)/i) ||
      first(ua, /\bOPiOS\/([\d.]+)/i) ||
      first(ua, /Opera Mini\/([\d.]+)/i) ||
      (/Opera\/9\.80/i.test(ua) ? first(ua, /\bVersion\/([\d.]+)/i) : '') ||
      first(ua, /\bOpera[\s/]([\d.]+)/i);
    return { browser: 'Opera', browserVersion: majorOf(version) };
  }
  if (/\bVivaldi\//i.test(ua)) {
    return { browser: 'Vivaldi', browserVersion: majorOf(first(ua, /\bVivaldi\/([\d.]+)/i)) };
  }
  if (/\bYaBrowser\//i.test(ua)) {
    return { browser: 'Yandex Browser', browserVersion: majorOf(first(ua, /\bYaBrowser\/([\d.]+)/i)) };
  }
  if (/\bSamsungBrowser\//i.test(ua)) {
    return { browser: 'Samsung Internet', browserVersion: majorOf(first(ua, /\bSamsungBrowser\/([\d.]+)/i)) };
  }
  if (/\bUCBrowser\/|\bUCWEB|\bUBrowser\//i.test(ua)) {
    return { browser: 'UC Browser', browserVersion: majorOf(first(ua, /\b(?:UCBrowser|UCWEB|UBrowser)\/([\d.]+)/i)) };
  }
  if (/\bBrave\b/i.test(ua)) {
    // Brave normally ships an unmodified Chrome UA; this only catches the
    // builds that do advertise themselves.
    return { browser: 'Brave', browserVersion: majorOf(first(ua, /\bBrave\/([\d.]+)/i)) || chromeVersion };
  }

  if (/\b(?:Firefox|FxiOS)\//i.test(ua)) {
    return { browser: 'Firefox', browserVersion: majorOf(first(ua, /\b(?:Firefox|FxiOS)\/([\d.]+)/i)) };
  }

  // Android WebView: modern builds carry the "wv" token, pre-Lollipop shells
  // are a bare WebKit with "Version/4.0" and no Chrome token at all.
  const isAndroidWebview =
    /;\s*wv[);]/i.test(ua) ||
    (os === 'Android' && /AppleWebKit/i.test(ua) && !chromeVersion && !!webkitVersion);
  if (isAndroidWebview) {
    return { browser: 'Chrome Webview', browserVersion: chromeVersion || webkitVersion };
  }

  if (chromeVersion) {
    return { browser: 'Chrome', browserVersion: chromeVersion };
  }

  if (/Safari\//i.test(ua) && /AppleWebKit/i.test(ua)) {
    return { browser: 'Safari', browserVersion: webkitVersion };
  }
  // iOS in-app browsers (Facebook, Instagram, LinkedIn…) are WebKit views that
  // drop the "Safari/" token but keep "Mobile/".
  if (os === 'iOS' && /AppleWebKit/i.test(ua)) {
    return { browser: 'Safari (in-app)', browserVersion: webkitVersion };
  }

  return { browser: '', browserVersion: '' };
}

/**
 * Parse a raw User-Agent header into display-ready fields.
 *
 * @param {string} ua Raw `User-Agent` header value.
 * @returns {{browser: string, browserVersion: string, os: string, osVersion: string, device: string}}
 *   `device` is always one of 'Desktop' | 'Mobile' | 'Tablet'; every other
 *   field is '' when it could not be determined.
 */
export function parseUserAgent(ua) {
  const raw = typeof ua === 'string' ? ua : '';
  const value = raw.length > MAX_UA_LENGTH ? raw.slice(0, MAX_UA_LENGTH) : raw;

  if (!value.trim()) {
    return { browser: '', browserVersion: '', os: '', osVersion: '', device: 'Desktop' };
  }

  const { os, osVersion } = detectOs(value);
  const { browser, browserVersion } = detectBrowser(value, os);
  return { browser, browserVersion, os, osVersion, device: detectDevice(value, os) };
}

/**
 * Coarse screen bucket from a viewport width in CSS pixels.
 * Accepts a number or a numeric string (the tracker sends it as a string).
 *
 * @param {number|string} width Viewport width in CSS pixels.
 * @returns {'Mobile'|'Tablet'|'Laptop'|'Desktop'|''} '' when the width is missing or invalid.
 */
export function screenSizeBucket(width) {
  const n = typeof width === 'number' ? width : Number(String(width ?? '').trim());
  if (!Number.isFinite(n) || n < 1) return '';
  if (n < 576) return 'Mobile';
  if (n < 992) return 'Tablet';
  if (n < 1440) return 'Laptop';
  return 'Desktop';
}
