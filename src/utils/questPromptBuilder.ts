import { SaaSSpec, BackendConfig } from '../types/spec';

/**
 * Builds a strict, deterministic code-generation brief by combining spec + backend
 * config with web-development best practices. This prompt is intentionally
 * structured so codegen receives explicit requirements instead of vague intent.
 */
export function buildQuestPrompt(spec: SaaSSpec, config: BackendConfig): string {
  const envBlock = [
    `NEXT_PUBLIC_INSFORGE_URL=${config.baseUrl}`,
    `NEXT_PUBLIC_INSFORGE_ANON_KEY=${config.anonKey}`,
    ...(config.storageEndpoint
      ? [`NEXT_PUBLIC_STORAGE_ENDPOINT=${config.storageEndpoint}`]
      : []),
  ].join('\n');

  const dataModelBlock = (config.liveSchema && config.liveSchema.length > 0
    ? config.liveSchema.map((table) => {
        const cols = table.columns
          .map((col) => `${col.name}:${col.dataType}${col.isNullable ? '?' : ''}`)
          .join(', ');
        return `- ${table.tableName}: ${cols}`;
      })
    : spec.dbSchema.map((table) => {
        const cols = table.columns
          .map((col) => {
            let typeStr = `${col.name}:${col.type}${col.nullable ? '?' : ''}`;
            if (col.referencedTable) {
              typeStr += ` → ${col.referencedTable}`;
            }
            return typeStr;
          })
          .join(', ');
        return `- ${table.name}: ${cols}`;
      }))
    .join('\n');

  const crudMatrix = spec.dbSchema
    .map((table) => `- ${table.name}: list, create, edit, delete`) 
    .join('\n');

  const featureChecklist: string[] = [];
  if (spec.features.includes('auth')) {
    featureChecklist.push(
      '- Auth: implement email/password with `insforge.auth.signUp`, `insforge.auth.signInWithPassword`, `insforge.auth.getCurrentUser`, `insforge.auth.signOut`; guard private routes and keep /login + /register + /verify public. TWO-FACTOR AUTH IS DISABLED.',
    );
    featureChecklist.push(
      '- Verification: after sign-up, handle email confirmation flow with a dedicated /verify screen that explains the code/email step and allows the user to complete verification before entering protected routes.',
    );
    featureChecklist.push(
      '- Demo user: create a convenient demo/seed user with known credentials (email: demo@example.com, password: demo123) so people can quickly test the app without signing up.',
    );
  }
  if (spec.features.includes('file_upload')) {
    featureChecklist.push(
      '- File upload: support uploading to storage bucket and persist file URL reference in related table rows.',
    );
  }
  if (spec.features.includes('notifications')) {
    featureChecklist.push(
      '- Notifications: show deterministic inline/toast feedback for create/update/delete success and failure.',
    );
  }
  if (spec.features.includes('analytics')) {
    featureChecklist.push(
      '- Analytics: build dashboard metrics using existing table data with lightweight visual components (no extra chart packages).',
    );
  }

  const baseRoutes = [
    '/ (overview/dashboard)',
    '/login',
    '/register',
    ...(spec.features.includes('auth') ? ['/verify'] : []),
  ];
  const resourceRoutes = spec.dbSchema.map((table) => `/${table.name}`);
  const routeBlock = [...baseRoutes, ...resourceRoutes]
    .map((route) => `- ${route}`)
    .join('\n');

  const entityHints = spec.entities.map((e) => `- ${e}`).join('\n');

  const strictAcceptance = [
    '- Every route renders meaningful UI (no placeholders/TODO screens).',
    '- For each table: users can list records, create records, update records, and delete records from UI.',
    '- Every data mutation has explicit loading + success + error UX state.',
    '- Forms must include labels, validation messages, disabled submit while pending, and keyboard-submit support.',
    '- Empty states and error states are required on all list/detail views.',
    '- Components must be exported in a way tests can import correctly (no default/named mismatch).',
    '- Keep generated tests aligned to visible UI copy and stable selectors.',
    ...(spec.features.includes('auth')
      ? [
          '- Registration must not redirect to protected app routes until the user has an authenticated session.',
          '- If signup requires email verification, /verify must be available and usable in the UI.',
          '- Auth guard must treat /verify as a public route.',
        ]
      : []),
  ].join('\n');

  return `
# PRODUCT OBJECTIVE
Build "${spec.name}" using template "${spec.template}" as a production-quality web app with robust CRUD, reliable auth, and testable UI behavior.

# ORIGINAL USER INTENT
${spec.questPrompt}

# DOMAIN MODEL (authoritative)
${dataModelBlock}

# ENTITIES (product language)
${entityHints}

# REQUIRED ROUTES
${routeBlock}

# CRUD MATRIX (mandatory)
${crudMatrix}

# DATA ACCESS CONTRACT
- Use @insforge/sdk only.
- Client must be initialized with:
  import { createClient } from '@insforge/sdk';
  export const insforge = createClient({ baseUrl: process.env.NEXT_PUBLIC_INSFORGE_URL!, anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY! });
- Use PostgREST-style calls: insforge.database.from('<table>').select()/insert([{...}])/update({...}).eq('id', id)/delete().eq('id', id).
- Select explicit columns for list/detail screens (avoid select('*') unless required).

# FOREIGN KEY + RELATIONSHIP FORMS
For any form field that references another table (columns ending with 'Id' like candidateId, contactId, projectId, etc.):
- Render as a <select> dropdown, NOT a text input
- On mount, fetch available options from the referenced table using a basic select query
- Display human-readable labels (e.g., contact name, project title) in the dropdown, NOT UUIDs
- Store the selected UUID value in state
- Mark as required unless the column is nullable
- Include a "-- Select --" placeholder if optional

Example pattern:
  const [candidates, setCandidates] = useState<Array<{id: string; name: string}>>([]);
  useEffect(() => {
    insforge.database.from('candidates').select('id,name').then(({data}) => setCandidates(data || []));
  }, []);
  // Then render: <select><option value="">-- Select candidate --</option>{candidates.map(c => ...)}</select>

# FEATURE CHECKLIST
${featureChecklist.length ? featureChecklist.join('\n') : '- No additional optional features requested.'}

# UX + ACCESSIBILITY REQUIREMENTS
- Use semantic HTML with explicit labels for all form controls.
- Provide loading, empty, success, and error states for every async surface.
- Buttons and links must have clear text and keyboard accessibility.
- Preserve readable color contrast and visible focus states.

# PERFORMANCE + MAINTAINABILITY REQUIREMENTS
- Keep components focused and composable.
- Avoid adding new npm dependencies unless absolutely necessary.
- Use parallel fetching where possible and avoid sequential waterfalls.
- Ensure imports/exports are consistent so tests can render components safely.

# TESTING REQUIREMENTS
- For each generated interactive .tsx component/page, include a corresponding .test.tsx.
- Assertions must target visible text or stable UI elements that actually render.
- No brittle assertions on placeholders that may not exist.
- Tests should validate core CRUD and auth flows at component/page level.

# ENVIRONMENT VARIABLES (exact names and values)
${envBlock}

# STRICT ACCEPTANCE CRITERIA
${strictAcceptance}

# FINAL CONSTRAINTS
- Keep TypeScript strict-safe.
- Use Tailwind CSS for styling.
- Do not introduce raw DB drivers or ORM layers.
- Deliver complete, coherent files ready to apply as patches.
`.trim();
}

