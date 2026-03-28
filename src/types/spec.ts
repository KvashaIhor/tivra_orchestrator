import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas (runtime validation)
// ---------------------------------------------------------------------------

export const TableColumnSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'integer', 'float', 'boolean', 'datetime', 'text', 'uuid']),
  nullable: z.boolean(),
  referencedTable: z.string().optional(),    // FK target table (e.g., 'candidates')
  referencedColumn: z.string().optional(),   // FK target column, defaults to 'id'
});

export const TableDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'table name must be snake_case (a-z, 0-9, _)'),
  columns: z.array(TableColumnSchema),
});

export const SaaSSpecSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  template: z.enum(['taskboard', 'crm', 'saas-starter']),
  entities: z.array(z.string()).min(1),
  features: z.array(z.enum(['auth', 'file_upload', 'notifications', 'analytics'])),
  dbSchema: z.array(TableDefinitionSchema).min(1),
  questPrompt: z.string().min(10),
});

// ---------------------------------------------------------------------------
// TypeScript interfaces (derived from Zod for consistency)
// ---------------------------------------------------------------------------

export type TableColumn = z.infer<typeof TableColumnSchema>;
export type TableDefinition = z.infer<typeof TableDefinitionSchema>;
export type SaaSSpec = z.infer<typeof SaaSSpecSchema>;

export interface LiveTableColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
}

export interface LiveTableSchema {
  tableName: string;
  columns: LiveTableColumn[];
}

// ---------------------------------------------------------------------------
// Backend config returned after Insforge provisioning
// ---------------------------------------------------------------------------

export interface BackendConfig {
  /** https://project.region.insforge.app — used by @insforge/sdk createClient() */
  baseUrl: string;
  /** Anon key for @insforge/sdk createClient() in the generated app */
  anonKey: string;
  /** Set only when file_upload is in spec.features */
  storageEndpoint?: string;
  /** Live DB schema snapshot for generated tables (authoritative at generation time). */
  liveSchema?: LiveTableSchema[];
}

// ---------------------------------------------------------------------------
// Agent event emitter type (feeds SSE stream)
// ---------------------------------------------------------------------------

export type EmitFn = (event: AgentEvent) => void;

export type AgentEventStep =
  | 'spec_parsed'
  | 'db_created'
  | 'auth_created'
  | 'storage_created'
  | 'migration_done'
  | 'functions_deployed'
  | 'code_generated'
  | 'tests_run'
  | 'app_deployed'
  | 'error';

export interface AgentEvent {
  step: AgentEventStep;
  message: string;
  data?: Record<string, unknown>;
  ts: number;
}

// ---------------------------------------------------------------------------
// Build state managed by the orchestrator
// ---------------------------------------------------------------------------

export interface BuildState {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  events: AgentEvent[];
  spec?: SaaSSpec;
  backendConfig?: BackendConfig;
  deployedUrl?: string;
  error?: string;
}

export const BuildCredentialOverridesSchema = z
  .object({
    anthropicApiKey: z.string().min(1).optional(),
    insforgeBaseUrl: z.string().url().optional(),
    insforgeAnonKey: z.string().min(1).optional(),
    insforgeAccessToken: z.string().min(1).optional(),
    insforgeRefreshToken: z.string().min(1).optional(),
    insforgeProjectId: z.string().min(1).optional(),
  })
  .partial();

export type BuildCredentialOverrides = z.infer<typeof BuildCredentialOverridesSchema>;

export const BuildRequestSchema = z.object({
  prompt: z.string().min(5),
  credentials: BuildCredentialOverridesSchema.optional(),
});

export type BuildRequest = z.infer<typeof BuildRequestSchema>;
