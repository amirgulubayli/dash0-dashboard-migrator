import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export const smallReport = (): any => JSON.parse(readFileSync(fixturePath("report.small.json"), "utf8"));
export const smallEventsText = (): string => readFileSync(fixturePath("events.small.jsonl"), "utf8");

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
