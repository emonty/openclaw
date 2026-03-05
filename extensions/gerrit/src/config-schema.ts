import { z } from "zod";

export const GerritAccountSchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string(),
  port: z.number().optional(),
  username: z.string(),
  sshKeyPath: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  projects: z.array(z.string()).optional(),
});

export const GerritConfigSchema = z.object({
  accounts: z.record(z.string(), GerritAccountSchema.optional()).optional(),
});
