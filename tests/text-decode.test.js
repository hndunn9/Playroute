// npm test   (node --test tests/*.test.js)
import test from "node:test";
import assert from "node:assert/strict";
import { decodeFeedBytes, decodeUtf8Lenient, repairReplacementChars, charsetFromContentType } from "../src/text-decode.js";

const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => Array.from(typeof p === "string" ? enc(p) : p)));

test("valid UTF-8 is unchanged", () => {
  const s = "¡Disfruta de libros, canciones y más en inglés y español! We’ll read — together.";
  assert.equal(decodeFeedBytes(enc(s)), s);
});

test("stray Windows-1252 bytes inside UTF-8 decode instead of becoming U+FFFD", () => {
  // Shape of the Boulder Communico export: UTF-8 é next to raw 0x92 / 0xA0 / 0x96.
  const bytes = cat("café. We", [0x92], "ll read books and", [0xA0], "play", [0xA0], "while ", [0x96], " and hop");
  const out = decodeUtf8Lenient(bytes);
  assert.equal(out, "café. We’ll read books and play while – and hop");
  assert.ok(!out.includes("�"));
});

test("truncated or overlong sequences fall back per byte", () => {
  assert.equal(decodeUtf8Lenient(Uint8Array.from([0x41, 0xC3])), "AÃ");
  assert.equal(decodeUtf8Lenient(Uint8Array.from([0xC0, 0xAF])), "À¯");
});

test("declared latin-1 / windows-1252 charset is honored", () => {
  const bytes = cat('<?xml version="1.0" encoding="ISO-8859-1"?><t>caf', [0xE9], " ", [0x93], "hi", [0x94], "</t>");
  assert.equal(decodeFeedBytes(bytes), '<?xml version="1.0" encoding="ISO-8859-1"?><t>café “hi”</t>');
  assert.equal(decodeFeedBytes(Uint8Array.from([0x63, 0x61, 0x66, 0xE9]), "text/xml; charset=windows-1252"), "café");
  assert.equal(charsetFromContentType('application/xml; charset="UTF-8"'), "utf-8");
});

test("literal U+FFFD is repaired to readable text", () => {
  assert.equal(repairReplacementChars("We�ll read books and share songs � and hop"),
    "We’ll read books and share songs – and hop");
  assert.equal(repairReplacementChars("sing songs, and�play�while"), "sing songs, and play while");
  assert.equal(repairReplacementChars("NoBo's storytime�for all ages."), "NoBo's storytime for all ages.");
  assert.equal(repairReplacementChars("no change"), "no change");
});
