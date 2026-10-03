import { describe, expect, test } from "vitest";
import { canonicalJson, sha256Hex, digestOf } from "../src/swarm/digest.js";

describe("canonicalJson", () => {
  test("sorts object keys recursively so content equality => string equality", () => {
    const a = { b: 1, a: { y: 2, x: 3 } };
    const b = { a: { x: 3, y: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":3,"y":2},"b":1}');
  });
  test("preserves array order (order is semantic, keys are not)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ xs: [{ b: 1, a: 2 }] })).toBe('{"xs":[{"a":2,"b":1}]}');
  });
  test("omits undefined fields (same as absent) but keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });
  test("stable regardless of insertion order for the same logical value", () => {
    const o1: Record<string, number> = {};
    o1.z = 1; o1.a = 2; o1.m = 3;
    const o2: Record<string, number> = {};
    o2.a = 2; o2.m = 3; o2.z = 1;
    expect(canonicalJson(o1)).toBe(canonicalJson(o2));
  });
  test("rejects non-finite numbers (a digest input must be well-defined)", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
  });
});

describe("sha256Hex", () => {
  test("known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("digestOf", () => {
  test("equal content (any key order) => equal digest", () => {
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
  });
  test("different content => different digest", () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });
  test("array element order changes the digest", () => {
    expect(digestOf([1, 2])).not.toBe(digestOf([2, 1]));
  });
});
