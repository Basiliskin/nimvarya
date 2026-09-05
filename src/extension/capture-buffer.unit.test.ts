import { describe, expect, it } from "vitest";

import {
  createCaptureRing,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  type CaptureRead,
} from "./capture-buffer.js";

interface Msg {
  readonly text: string;
}

const msg = (text: string): Msg => ({ text });

describe("exported constants", () => {
  it("pin the documented defaults so a rename or retune breaks the test", () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(500);
    expect(DEFAULT_READ_LIMIT).toBe(100);
    expect(MAX_READ_LIMIT).toBe(500);
  });
});

describe("createCaptureRing — seq stamping", () => {
  it("assigns strictly consecutive seqs starting at 1 and returns them", () => {
    const ring = createCaptureRing<Msg>(10);
    expect(ring.push(msg("a"))).toBe(1);
    expect(ring.push(msg("b"))).toBe(2);
    expect(ring.push(msg("c"))).toBe(3);
  });

  it("rejects a non-positive-integer maxEntries with a typed error", () => {
    expect(() => createCaptureRing<Msg>(0)).toThrow(RangeError);
    expect(() => createCaptureRing<Msg>(-1)).toThrow(RangeError);
    expect(() => createCaptureRing<Msg>(1.5)).toThrow(RangeError);
  });
});

describe("read — since/limit window arithmetic", () => {
  it("returns entries with seq > since, ascending, with the right nextSince", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c", "d", "e"]) ring.push(msg(t));

    const r: CaptureRead<Msg> = ring.read({ since: 2, limit: 100 });
    expect(r.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(r.entries[0]?.text).toBe("c");
    expect(r.nextSince).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.dropped).toBe(false);
  });

  it("sets truncated when strictly more matched than limit", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c", "d", "e"]) ring.push(msg(t));

    const r = ring.read({ since: 2, limit: 2 });
    expect(r.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(r.nextSince).toBe(4);
    expect(r.truncated).toBe(true);
  });

  it("does NOT set truncated when match count equals limit exactly", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c"]) ring.push(msg(t));

    const r = ring.read({ since: 0, limit: 3 });
    expect(r.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.truncated).toBe(false);
  });

  it("echoes the caller's since (not 0, not undefined) on an empty match", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c", "d", "e"]) ring.push(msg(t));

    const r = ring.read({ since: 5, limit: 10 });
    expect(r.entries).toEqual([]);
    expect(r.nextSince).toBe(5);
    expect(r.dropped).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("advances nextSince across successive reads", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c", "d"]) ring.push(msg(t));

    const first = ring.read({ since: 0, limit: 2 });
    expect(first.nextSince).toBe(2);
    const second = ring.read({ since: first.nextSince, limit: 2 });
    expect(second.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(second.nextSince).toBe(4);
  });
});

describe("read — wrap-around and the dropped flag", () => {
  it("keeps the newest N, drops the oldest, never reuses a seq", () => {
    const ring = createCaptureRing<Msg>(3);
    for (const t of ["a", "b", "c", "d", "e"]) ring.push(msg(t));

    expect(ring.size()).toBe(3);
    const r = ring.read({ since: 0, limit: 10 });
    expect(r.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("computes dropped as oldestSeq > since + 1 — both sides of the boundary", () => {
    const ring = createCaptureRing<Msg>(3);
    for (const t of ["a", "b", "c", "d", "e"]) ring.push(msg(t)); // oldest retained seq = 3

    expect(ring.read({ since: 2, limit: 10 }).dropped).toBe(false);
    expect(ring.read({ since: 1, limit: 10 }).dropped).toBe(true);
    expect(ring.read({ since: 0, limit: 10 }).dropped).toBe(true);
  });

  it("dropped is false on a fresh buffer read with since 0", () => {
    const ring = createCaptureRing<Msg>(5);
    ring.push(msg("a"));
    expect(ring.read({ since: 0, limit: 10 }).dropped).toBe(false);
  });

  it("wraps more than once without corruption", () => {
    const ring = createCaptureRing<Msg>(4);
    for (let i = 0; i < 4 * 2 + 1; i += 1) ring.push(msg(`m${String(i)}`));

    const r = ring.read({ since: 0, limit: 100 });
    expect(r.entries.map((e) => e.seq)).toEqual([6, 7, 8, 9]);
    expect(ring.size()).toBe(4);
  });
});

describe("read — stale cursor and clear()", () => {
  it("treats since greater than newest seq as a full window", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c"]) ring.push(msg(t));

    const r = ring.read({ since: 999, limit: 10 });
    expect(r.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.nextSince).toBe(3);
  });

  it("treats since equal to newest seq as a normal empty read (not stale)", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c"]) ring.push(msg(t));

    expect(ring.read({ since: 3, limit: 10 }).entries).toEqual([]);
  });

  it("a stale read on an empty ring does not throw and does not strand the cursor", () => {
    const ring = createCaptureRing<Msg>(10);
    const empty = ring.read({ since: 7, limit: 10 });
    expect(empty.entries).toEqual([]);
    expect(empty.nextSince).toBe(0);

    ring.push(msg("a"));
    ring.push(msg("b"));
    expect(ring.read({ since: empty.nextSince, limit: 10 }).entries.map((e) => e.seq)).toEqual([
      1, 2,
    ]);
  });

  it("clear() empties the ring but keeps the seq counter monotonic", () => {
    const ring = createCaptureRing<Msg>(10);
    ring.push(msg("a"));
    ring.push(msg("b"));
    ring.push(msg("c"));
    ring.clear();

    expect(ring.size()).toBe(0);
    const r: CaptureRead<Msg> = ring.read({ since: 0, limit: 10 });
    expect(r.entries).toEqual([]);
    expect(r.dropped).toBe(false);
    expect(r.truncated).toBe(false);

    expect(ring.push(msg("d"))).toBe(4); // counter not rewound
  });
});

describe("read — non-destructive and bounded", () => {
  it("returns deep-equal results on repeated identical reads", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c"]) ring.push(msg(t));

    const a = ring.read({ since: 0, limit: 10 });
    const sizeAfterFirst = ring.size();
    const b = ring.read({ since: 0, limit: 10 });
    expect(a).toEqual(b);
    expect(ring.size()).toBe(sizeAfterFirst);
  });

  it("stays bounded at maxEntries under a very large push count", () => {
    const ring = createCaptureRing<Msg>(500);
    for (let i = 0; i < 5000; i += 1) ring.push(msg("x"));
    expect(ring.size()).toBe(500);

    const r = ring.read({ since: 0, limit: MAX_READ_LIMIT });
    expect(r.entries).toHaveLength(500);
    expect(r.entries[0]?.seq).toBe(4501);
    expect(r.entries[499]?.seq).toBe(5000);
  });

  it("uses DEFAULT_MAX_ENTRIES when constructed with no argument", () => {
    const ring = createCaptureRing<Msg>();
    for (let i = 0; i < 600; i += 1) ring.push(msg("x"));
    expect(ring.size()).toBe(DEFAULT_MAX_ENTRIES);
  });

  it("clamps limit above MAX_READ_LIMIT and yields an empty page for limit <= 0", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b", "c"]) ring.push(msg(t));

    expect(ring.read({ since: 0, limit: 0 }).entries).toEqual([]);
    expect(ring.read({ since: 0, limit: -1 }).entries).toEqual([]);
    // limit 0 => nothing returned but there IS more => truncated
    expect(ring.read({ since: 0, limit: 0 }).truncated).toBe(true);

    const big = createCaptureRing<Msg>(MAX_READ_LIMIT + 100);
    for (let i = 0; i < MAX_READ_LIMIT + 50; i += 1) big.push(msg("x"));
    expect(big.read({ since: 0, limit: 999_999 }).entries).toHaveLength(MAX_READ_LIMIT);
  });

  it("does not expose the internal storage array", () => {
    const ring = createCaptureRing<Msg>(10);
    ring.push(msg("a"));
    const r = ring.read({ since: 0, limit: 10 });
    (r.entries as Array<Msg & { seq: number }>).push({ text: "injected", seq: 99 });
    expect(ring.read({ since: 0, limit: 10 }).entries).toHaveLength(1);
  });

  it("treats a non-integer since as 0", () => {
    const ring = createCaptureRing<Msg>(10);
    for (const t of ["a", "b"]) ring.push(msg(t));
    expect(ring.read({ since: Number.NaN, limit: 10 }).entries.map((e) => e.seq)).toEqual([
      1, 2,
    ]);
  });
});
