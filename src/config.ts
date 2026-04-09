import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  VAULT_PATH: z.string().min(1, 'VAULT_PATH is required'),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  OPENCLAW_GATEWAY_URL: z.string().optional().default('http://localhost:3100'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`);
    throw new Error(`Configuration validation failed:\n${missing.join('\n')}`);
  }
  return result.data;
}

export const config: Config = loadConfig();
