import { z } from "zod";

const ConfigSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  COMFY_URL: z.string().url().default("https://unc-cozy.artokun.io"),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(5),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000), // 30 min
  SESSION_MAX_DURATION_MS: z.coerce.number().int().positive().default(7_200_000), // 2 hours
  MAX_TURNS: z.coerce.number().int().positive().default(50),
  PROJECT_DIR: z.string().default("/tmp/discord-projects"),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid config:", result.error.flatten().fieldErrors);
    process.exit(1);
  }
  _config = result.data;
  return _config;
}
