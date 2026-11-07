// Where dd2dash0's own files live (mappings/, console/): next to the standalone executable when it is one, else the
// repository the CLI runs from. DD2DASH0_HOME overrides both.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const hasMappings = (dir: string) => existsSync(join(dir, "mappings", "tags.yaml"));

export function homeDir(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, here = import.meta.dirname): string {
  const candidates = [env.DD2DASH0_HOME, dirname(execPath), join(dirname(execPath), ".."), join(here, "..")].filter((c): c is string => !!c);
  return candidates.find(hasMappings) ?? join(here, "..");
}

export const defaultMappingsDir = () => join(homeDir(), "mappings");
