import { SaaSSpec, EmitFn, BackendConfig, TableDefinition } from '../types/spec';
import { runDbQuery, createStorageBucket, getBaseUrl, getAnonKey, getLiveTableSchemas } from '../clients/insforge';
import { log } from '../utils/log';

// ---------------------------------------------------------------------------
// Type mapping: SaaSSpec column types → Postgres column types
// ---------------------------------------------------------------------------

const PG_TYPE: Record<string, string> = {
  uuid: 'UUID',
  string: 'TEXT',
  integer: 'INTEGER',
  float: 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
  datetime: 'TIMESTAMPTZ',
  text: 'TEXT',
};

function tableToSql(table: TableDefinition): string {
  const colDefs = table.columns.map((col) => {
    if (col.name === 'id') {
      return 'id UUID PRIMARY KEY DEFAULT gen_random_uuid()';
    }
    if (col.name === 'createdAt') {
      return '"createdAt" TIMESTAMPTZ DEFAULT NOW()';
    }
    const pgType = PG_TYPE[col.type] ?? 'TEXT';
    const nullability = col.nullable ? '' : ' NOT NULL';
    return `"${col.name}" ${pgType}${nullability}`;
  });

  return `CREATE TABLE IF NOT EXISTS "${table.name}" (${colDefs.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Provisioner
// ---------------------------------------------------------------------------

export async function provisionBackend(
  spec: SaaSSpec,
  emit: EmitFn,
): Promise<BackendConfig> {
  log.info(`provisionBackend start — spec="${spec.name}" tables=${spec.dbSchema.length} features=[${spec.features.join(',')}]`);
  const baseUrl = getBaseUrl();
  const anonKey = getAnonKey();
  log.info(`InsForge baseUrl=${baseUrl}`);

  // 1. Create DB tables via CLI
  emit({ step: 'db_created', message: 'Creating database tables…', ts: Date.now() });
  for (const table of spec.dbSchema) {
    const sql = tableToSql(table);
    log.info(`Creating table "${table.name}" (${table.columns.length} columns)`);
    try {
      const result = await runDbQuery(sql);
      log.ok(`Table "${table.name}" created`, result);
    } catch (err: unknown) {
      log.error(`Failed to create table "${table.name}"`, { sql, error: (err as Error).message });
      throw err;
    }
    emit({
      step: 'db_created',
      message: `Table "${table.name}" ready`,
      ts: Date.now(),
    });
  }
  emit({ step: 'db_created', message: 'All tables created ✓', ts: Date.now() });
  log.ok(`All ${spec.dbSchema.length} tables created`);

  // 1b. Capture live schema snapshot so generation can align to real DB columns/nullability.
  const tableNames = spec.dbSchema.map((t) => t.name);
  const liveSchema = await getLiveTableSchemas(tableNames);
  emit({
    step: 'migration_done',
    message: `Live schema snapshot captured for ${liveSchema.length} table(s)`,
    data: {
      tables: liveSchema.map((t) => ({
        tableName: t.tableName,
        columns: t.columns.map((c) => ({ name: c.name, isNullable: c.isNullable })),
      })),
    },
    ts: Date.now(),
  });

  // 2. Auth — built into every Insforge project, no provisioning needed
  emit({
    step: 'auth_created',
    message: 'Auth ready (email/password built-in via Insforge ✓)',
    ts: Date.now(),
  });

  // 3. Storage bucket (only when spec requires file_upload)
  let storageEndpoint: string | undefined;
  if (spec.features.includes('file_upload')) {
    emit({ step: 'storage_created', message: 'Creating storage bucket…', ts: Date.now() });
    const bucketName = `${spec.name}-files`;
    await createStorageBucket(bucketName);
    storageEndpoint = `${baseUrl}/api/storage/buckets/${bucketName}/objects`;
    emit({
      step: 'storage_created',
      message: `Storage bucket "${bucketName}" ready ✓`,
      data: { bucket: bucketName },
      ts: Date.now(),
    });
  }

  // 4. Backend fully configured — DB + Auth + (optional) Storage all live
  emit({
    step: 'functions_deployed',
    message: 'Backend configured — DB, Auth & Storage ready via Insforge ✓',
    ts: Date.now(),
  });

  return { baseUrl, anonKey, storageEndpoint, liveSchema };
}
