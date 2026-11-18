// Decoding fetched feeds without losing characters.
//
// Response.text() always decodes as UTF-8 and turns any byte that isn't valid
// UTF-8 into U+FFFD (�). Some feeds aren't clean UTF-8: the Boulder Public
// Library Communico export is mostly UTF-8 (é, ñ, ¡ come through fine) but
// some descriptions carry raw Windows-1252 bytes (0x92 ’, 0x96 –, 0xA0 no-break
// space), which showed up as "We�ll" and "and�play�while" in ~95 events.
//
// decodeFeedBytes() keeps valid UTF-8 as is, honors a declared non-UTF-8
// charset, and maps any stray invalid byte through Windows-1252 instead of
// replacing it with �. repairReplacementChars() is a last resort for text
// that already contains a literal U+FFFD (nothing left to decode).

// Windows-1252 0x80–0x9F (the bytes where it differs from ISO-8859-1).
// Undefined slots (0x81, 0x8D, 0x8F, 0x90, 0x9D) map to the same code point.
const CP1252_HIGH = [
  0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
  0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178
];

function cp1252Char(b) {
  return String.fromCharCode(b >= 0x80 && b <= 0x9F ? CP1252_HIGH[b - 0x80] : b);
}

const LATIN1_LABELS = /^(?:iso-?8859-1|latin-?1|l1|windows-1252|cp1252|us-ascii|ascii)$/i;
const UTF8_LABELS = /^(?:utf-?8|unicode-1-1-utf-8)$/i;

export function charsetFromContentType(contentType) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || "");
  return m ? m[1].toLowerCase() : null;
}

// <?xml ... encoding="..."?> or <meta charset="..."> near the top of the body.
export function charsetFromBody(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  const m = /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head) ||
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

function decodeCp1252(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += Array.from(bytes.subarray(i, i + 8192), cp1252Char).join("");
  }
  return out;
}

// Length of the valid UTF-8 sequence starting at i, or 0 if it isn't one.
function utf8SeqLen(bytes, i) {
  const b0 = bytes[i];
  let len, min;
  if (b0 < 0x80) return 1;
  if (b0 >= 0xC2 && b0 <= 0xDF) { len = 2; min = 0x80; }
  else if (b0 >= 0xE0 && b0 <= 0xEF) { len = 3; min = 0x800; }
  else if (b0 >= 0xF0 && b0 <= 0xF4) { len = 4; min = 0x10000; }
  else return 0;
  if (i + len > bytes.length) return 0;
  let cp = b0 & (0xFF >> (len + 1));
  for (let k = 1; k < len; k++) {
    const b = bytes[i + k];
    if ((b & 0xC0) !== 0x80) return 0;
    cp = (cp << 6) | (b & 0x3F);
  }
  if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
  return len;
}

// UTF-8, but a byte that can't start a valid sequence is read as Windows-1252.
export function decodeUtf8Lenient(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // fall through to the byte-by-byte path
  }
  const utf8 = new TextDecoder("utf-8");
  let out = "", runStart = 0, i = 0;
  while (i < bytes.length) {
    const len = utf8SeqLen(bytes, i);
    if (len) { i += len; continue; }
    if (i > runStart) out += utf8.decode(bytes.subarray(runStart, i));
    out += cp1252Char(bytes[i]);
    i += 1;
    runStart = i;
  }
  if (runStart < bytes.length) out += utf8.decode(bytes.subarray(runStart));
  return out;
}

export function decodeFeedBytes(input, contentType = "") {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const declared = charsetFromContentType(contentType) || charsetFromBody(bytes);
  if (!declared || UTF8_LABELS.test(declared)) return decodeUtf8Lenient(bytes);
  if (LATIN1_LABELS.test(declared)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    return decodeUtf8Lenient(bytes); // unknown label in this runtime
  }
}

// Body of a fetch Response, decoded as above (use instead of res.text()).
export async function responseText(res) {
  return decodeFeedBytes(await res.arrayBuffer(), res.headers.get("content-type") || "");
}

// Text that already holds U+FFFD can't be decoded back, so make it read
// cleanly: an apostrophe in a contraction or possessive (We�ll, kid�s), a
// dash between spaces ( � ), and a space anywhere else (and�play).
const CONTRACTION_RE = /(\p{L})�(s|t|d|m|ll|re|ve)(?!\p{L})/gu;
export function repairReplacementChars(s) {
  if (!s || !s.includes("�")) return s;
  return s
    .replace(CONTRACTION_RE, "$1’$2")
    .replace(/ � /g, " – ")
    .replace(/�+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}
