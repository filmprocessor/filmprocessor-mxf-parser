import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeBER,
  isPictureElement,
  isSoundElement,
  isSMPTEKey,
  matchUL,
  parseLocalSet,
} from "../src/index.js";

test("decodeBER handles short and long form lengths", () => {
  assert.deepEqual(decodeBER(new Uint8Array([0x7f]), 0), {
    length: 127,
    bytesRead: 1,
  });
  assert.deepEqual(decodeBER(new Uint8Array([0x82, 0x01, 0x00]), 0), {
    length: 256,
    bytesRead: 3,
  });
});

test("SMPTE key and UL matching helpers recognize prefixes", () => {
  const key = new Uint8Array([
    0x06, 0x0e, 0x2b, 0x34, 0x01, 0x02, 0x01, 0x01,
    0x0d, 0x01, 0x03, 0x01, 0x15, 0x01, 0x05, 0x01,
  ]);
  assert.equal(isSMPTEKey(key, 0), true);
  assert.equal(matchUL(key, 0, [0x06, 0x0e, 0x2b, 0x34]), true);
});

test("picture and sound element matching tolerates version-byte variation", () => {
  const picture = new Uint8Array([
    0x06, 0x0e, 0x2b, 0x34, 0x01, 0x02, 0x01, 0xff,
    0x0d, 0x01, 0x03, 0x01, 0x15, 0x01, 0x05, 0x01,
  ]);
  const sound = new Uint8Array([
    0x06, 0x0e, 0x2b, 0x34, 0x01, 0x02, 0x01, 0x02,
    0x0d, 0x01, 0x03, 0x01, 0x16, 0x01, 0x01, 0x01,
  ]);
  assert.equal(isPictureElement(picture, 0), true);
  assert.equal(isSoundElement(sound, 0), true);
});

test("parseLocalSet reads tag-length-value properties", () => {
  const data = new Uint8Array([
    0x32, 0x03, 0x00, 0x04, 0x00, 0x00, 0x08, 0x00,
    0x32, 0x02, 0x00, 0x04, 0x00, 0x00, 0x04, 0x38,
  ]);
  const props = parseLocalSet(data, 0, data.length);
  assert.deepEqual(Array.from(props[0x3203]), [0x00, 0x00, 0x08, 0x00]);
  assert.deepEqual(Array.from(props[0x3202]), [0x00, 0x00, 0x04, 0x38]);
});
