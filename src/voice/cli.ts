// `dd2dash0 voice setup [--dry-run] [--agent-id <id>] [--llm <model>]`: create or update the ElevenLabs narrator
// agent and its two client tools from the spec in agent.ts. Idempotent (matches by name). Reads ELEVENLABS_API_KEY.
import { AGENT_NAME, setupAgent } from "./agent.js";

export const VOICE_USAGE = `dd2dash0 voice setup [--dry-run] [--agent-id <id>] [--llm <model>]
  creates or updates the ElevenLabs agent "${AGENT_NAME}" and its client tools get_summary, get_item_details.
  Needs ELEVENLABS_API_KEY. Re-running updates in place. serve then finds the agent by name.`;

export async function runVoice(args: string[], env: NodeJS.ProcessEnv = process.env, f?: typeof fetch): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "setup") {
    console.error(VOICE_USAGE);
    return 2;
  }
  let dryRun = false, agentId: string | undefined, llm: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i], v = rest[i + 1];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--agent-id" && v) (agentId = v), i++;
    else if (a === "--llm" && v) (llm = v), i++;
    else {
      console.error(`unknown or incomplete option ${a}\n\n${VOICE_USAGE}`);
      return 2;
    }
  }
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    console.error("ELEVENLABS_API_KEY is not set");
    return 2;
  }
  try {
    const r = await setupAgent({ apiKey, dryRun, log: (l) => console.log(l), ...(agentId ? { agentId } : {}), ...(llm ? { llm } : {}), ...(f ? { fetch: f } : {}) });
    if (r.agentId && !dryRun) console.log(`ready: dd2dash0 serve finds it by name (or set ELEVENLABS_AGENT_ID=${r.agentId})`);
    return 0;
  } catch (e) {
    console.error(`dd2dash0 voice: ${(e as Error).message}`);
    return 1;
  }
}
