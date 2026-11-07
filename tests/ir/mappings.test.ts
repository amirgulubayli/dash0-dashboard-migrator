import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetricTable, parseTagTable, loadMappings, kindTransform, MappingError, worst, reportLabel } from "../../src/ir/index.js";

const root = join(import.meta.dirname, "..", "..");
const table = (body: string) => `version: 1\nintegration: t\nmetrics:\n${body}`;

describe("parseMetricTable validates strictly", () => {
  it("accepts a well-formed entry", () => {
    const t = parseMetricTable(table(`  a.b:\n    otel: "x.y"\n    ddKind: gauge\n    otelKind: gauge\n    status: exact\n`));
    expect(t.metrics.get("a.b")).toMatchObject({ otel: "x.y", status: "exact", labels: {}, sumBy: [] });
  });
  it.each([
    ["an unknown field (typo)", `  a:\n    otell: "x"\n    ddKind: gauge\n    otelKind: gauge\n    status: exact\n`, /unknown field 'otell'/],
    ["a bad status", `  a:\n    otel: "x"\n    ddKind: gauge\n    otelKind: gauge\n    status: fine\n`, /status must be/],
    ["status none with an otel name", `  a:\n    otel: "x"\n    ddKind: gauge\n    otelKind: gauge\n    status: none\n`, /status none requires otel: null/],
    ["null otel claiming exact", `  a:\n    otel: null\n    ddKind: gauge\n    otelKind: null\n    status: exact\n`, /otel is null/],
    ["a missing otelKind", `  a:\n    otel: "x"\n    ddKind: gauge\n    status: exact\n`, /otelKind is required/],
    ["a bad ddKind", `  a:\n    otel: "x"\n    ddKind: counter\n    otelKind: gauge\n    status: exact\n`, /ddKind must be/],
    ["a zero scale", `  a:\n    otel: "x"\n    ddKind: gauge\n    otelKind: gauge\n    status: exact\n    scale: 0\n`, /scale/],
  ])("rejects %s", (_name, body, re) => {
    expect(() => parseMetricTable(table(body))).toThrow(MappingError);
    expect(() => parseMetricTable(table(body))).toThrow(re);
  });
  it("rejects an unsupported version", () => expect(() => parseMetricTable("version: 2\nintegration: t\nmetrics: {}\n")).toThrow(/version/));
});

describe("parseTagTable", () => {
  it("rejects a label that is not a valid PromQL label name", () => {
    expect(() => parseTagTable("version: 1\ntags:\n  env:\n    label: deployment.environment\n    status: exact\n")).toThrow(/valid PromQL label/);
  });
});

describe("the shipped mapping tables", () => {
  const m = loadMappings(join(root, "mappings"));
  const get = (k: string) => {
    const x = m.metrics.get(k);
    if (!x) throw new Error(`missing ${k}`);
    return x;
  };

  it("load without errors: 271 redisdb metrics and the core tags", () => {
    expect(m.metrics.size).toBe(271);
    expect(m.tags.get("service")?.label).toBe("service_name");
  });

  it("cover every metric used by the Redis overview dashboard and the high-memory monitor", () => {
    const used = new Set<string>();
    for (const f of ["fixtures/datadog/dashboards/redisdb__overview.json", "fixtures/datadog/monitors/redisdb__high_mem.json"]) {
      for (const x of readFileSync(join(root, f), "utf8").matchAll(/(?:avg|sum|min|max|count|p\d+):([a-z0-9_.]+)/g)) used.add(x[1]!);
    }
    expect(used.size).toBe(24);
    const missing = [...used].filter((k) => !m.metrics.has(k));
    expect(missing).toEqual([]);
    const translatable = [...used].filter((k) => m.metrics.get(k)!.status !== "none");
    expect(translatable).toHaveLength(18);
  });

  it("D-18: Datadog RATE_KEYS on an OTel counter need rate() and are not exact", () => {
    for (const k of ["redis.cpu.sys", "redis.cpu.user", "redis.net.commands", "redis.stats.keyspace_hits"]) {
      expect(kindTransform(get(k))).toMatchObject({ transform: "rate", status: "bounded" });
    }
  });

  it("redis.cpu.* select the right state attribute", () => {
    expect(get("redis.cpu.sys")).toMatchObject({ otel: "redis.cpu.time", labels: { state: "sys" } });
    expect(get("redis.cpu.user")).toMatchObject({ otel: "redis.cpu.time", labels: { state: "user" } });
  });

  it("D-19: running-total gauges map to the raw counter value, exact", () => {
    for (const k of ["redis.keys.evicted", "redis.keys.expired", "redis.net.rejected"]) {
      expect(kindTransform(get(k))).toEqual({ transform: "none", status: "exact" });
    }
  });

  it("the high-memory monitor's two metrics are exact gauges", () => {
    expect(kindTransform(get("redis.mem.used"))).toEqual({ transform: "none", status: "exact" });
    expect(get("redis.mem.maxmemory").otel).toBe("redis.maxmemory");
  });

  it("derived and missing equivalents are manual, never guessed", () => {
    expect(kindTransform(get("redis.expires.percent"))).toMatchObject({ status: "manual", reason: expect.stringContaining("derived") });
    expect(kindTransform(get("redis.info.latency_ms"))).toMatchObject({ status: "manual", reason: "no equivalent metric" });
  });
});

describe("status lattice", () => {
  it("worst() picks the weakest status", () => {
    expect(worst()).toBe("exact");
    expect(worst("exact", "exact-under")).toBe("exact-under");
    expect(worst("bounded", "exact-under", "exact")).toBe("bounded");
    expect(worst("exact", "manual", "bounded")).toBe("manual");
  });
  it("reportLabel() maps to the brief's three words", () => {
    expect(["exact", "exact-under", "bounded", "manual"].map((s) => reportLabel(s as never))).toEqual(["exact", "approximate", "approximate", "manual"]);
  });
});
