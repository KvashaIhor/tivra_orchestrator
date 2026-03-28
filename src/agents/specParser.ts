import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { SaaSSpec, SaaSSpecSchema } from '../types/spec';
import { log } from '../utils/log';
import { getBuildCredentials } from '../runtime/buildCredentials';

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function getAnthropic(): Anthropic {
  const { anthropicApiKey } = getBuildCredentials();
  const apiKey = anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to apps/orchestrator/.env or provide one in the build request.');
  return new Anthropic({ apiKey });
}

function loadSystemPrompt(): string {
  const candidates = [
    path.join(__dirname, '../prompts/specSystem.txt'),
    path.resolve(process.cwd(), 'src/prompts/specSystem.txt'),
    path.resolve(process.cwd(), 'dist/prompts/specSystem.txt'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  }

  throw new Error(`specSystem.txt not found. Tried: ${candidates.join(', ')}`);
}

const SYSTEM_PROMPT = loadSystemPrompt();

/**
 * Infer foreign key relationships from column naming patterns.
 * If a column ends with 'Id' and matches a table name (singularized or pluralized),
 * auto-populate referencedTable and referencedColumn.
 */
function inferForeignKeys(spec: SaaSSpec): SaaSSpec {
  const tableNames = spec.dbSchema.map((t) => t.name);
  const tableNameToSingular: Record<string, string> = {};

  // Build a map of plural table names to singular entity names for matching
  // e.g., { candidates: candidate, contacts: contact, projects: project }
  spec.dbSchema.forEach((table) => {
    const singular =
      table.name.endsWith('s') && !table.name.endsWith('ss')
        ? table.name.slice(0, -1) // contacts -> contact
        : table.name; // users -> users
    tableNameToSingular[table.name] = singular;
  });

  const updated = {
    ...spec,
    dbSchema: spec.dbSchema.map((table) => ({
      ...table,
      columns: table.columns.map((col) => {
        // Skip if already has referencedTable (explicitly set)
        if (col.referencedTable) return col;

        // Check if this looks like a foreign key (ends with 'Id' or 'id')
        const match = col.name.match(/^(.+?)(?:Id|id)$/);
        if (!match) return col;

        const singular = match[1];

        // Find matching table (check both singular and plural forms)
        let targetTable = tableNames.find((t) => tableNameToSingular[t] === singular);
        if (!targetTable) {
          targetTable = tableNames.find((t) => t === singular);
        }

        if (targetTable) {
          return {
            ...col,
            referencedTable: targetTable,
            referencedColumn: col.referencedColumn || 'id',
          };
        }

        return col;
      }),
    })),
  };

  return updated;
}

export async function parsePromptToSpec(userPrompt: string): Promise<SaaSSpec> {
  log.info(`parsePromptToSpec — prompt="${userPrompt.slice(0, 120)}"`);
  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT + '\n\nRespond with only a valid JSON object. No markdown, no code fences.',
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = response.content[0];
  let raw = block.type === 'text' ? extractJson(block.text) : '';
  log.info(`Claude response received (${raw.length} chars)`);
  if (!raw) {
    log.error('Claude returned an empty response');
    throw new Error('Claude returned an empty response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude response is not valid JSON: ${raw.slice(0, 200)}`);
  }

  const result = SaaSSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    log.error(`Spec validation failed`, { issues, raw: raw.slice(0, 500) });
    throw new Error(`Spec validation failed: ${issues}`);
  }

  // Infer foreign keys if not explicitly provided
  const specWithFKs = inferForeignKeys(result.data);

  const tableCount = specWithFKs.dbSchema.length;
  log.ok(`Spec parsed — name="${specWithFKs.name}" template=${specWithFKs.template} tables=${tableCount}`);
  return specWithFKs;
}
