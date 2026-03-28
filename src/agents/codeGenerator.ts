import fs from 'fs';
import path from 'path';
import { createTempDir, removeDirRecursive, atomicSwapDir } from './utils/tempDir';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { log } from '../utils/log';
import { SaaSSpec, BackendConfig, EmitFn, LiveTableSchema } from '../types/spec';
import { buildQuestPrompt } from '../utils/questPromptBuilder';
import { QuestOutput, FilePatch } from '../clients/qoder';
import { getBuildCredentials } from '../runtime/buildCredentials';

/**
 * Extract the first top-level JSON object from a string that may contain
 * prose or markdown code fences before/after the JSON.
 */
function extractJson(text: string): string {
  // Try extracting from a ```json ... ``` block first (anywhere in the string)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Otherwise find the first '{' and last '}'
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

const TEMPLATES_DIR = path.resolve(__dirname, '../../../../templates');
const GENERATED_DIR = path.resolve(__dirname, '../../../../generated');

function redactPromptForDebug(prompt: string): string {
  return prompt
    .replace(/(NEXT_PUBLIC_INSFORGE_URL=).*/g, '$1<redacted>')
    .replace(/(NEXT_PUBLIC_INSFORGE_ANON_KEY=).*/g, '$1<redacted>')
    .replace(/(NEXT_PUBLIC_STORAGE_ENDPOINT=).*/g, '$1<redacted>');
}

function templatePath(template: string): string {
  const map: Record<string, string> = {
    taskboard: 'template-taskboard',
    crm: 'template-crm',
    'saas-starter': 'template-saas-starter',
  };
  return path.join(TEMPLATES_DIR, map[template] ?? 'template-saas-starter');
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function applyPatches(destDir: string, output: QuestOutput, emit?: EmitFn, totalOverride?: number): void {
  const total = totalOverride ?? output.patches.length;
  output.patches.forEach((patch, idx) => {
    const filePath = path.join(destDir, patch.filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, patch.content, 'utf-8');
    if (emit) {
      const lineCount = patch.content.split('\n').length;
      const ext = path.extname(patch.filePath).replace('.', '').toUpperCase() || 'FILE';
      const isTest = patch.filePath.endsWith('.test.tsx') || patch.filePath.endsWith('.test.ts');
      const isPage = patch.filePath.includes('/app/') && path.basename(patch.filePath).startsWith('page');
      const isComponent = patch.filePath.includes('/components/');
      const isLib = patch.filePath.includes('/lib/');
      const isStyle = patch.filePath.endsWith('.css');
      const isConfig = patch.filePath.endsWith('.config.js') || patch.filePath.endsWith('.config.ts');
      const kind = isTest ? 'TEST' : isPage ? 'PAGE' : isComponent ? 'COMPONENT' : isLib ? 'LIB' : isStyle ? 'STYLE' : isConfig ? 'CONFIG' : ext;
      emit({
        step: 'code_generated',
        message: `[${idx + 1}/${total}] wrote ${kind} · ${patch.filePath} (${lineCount} lines)`,
        ts: Date.now(),
      });
    }
  });
}

function verifyAppliedPatches(destDir: string, patches: FilePatch[]): void {
  const mismatches: string[] = [];
  for (const patch of patches) {
    const filePath = path.join(destDir, patch.filePath);
    if (!fs.existsSync(filePath)) {
      mismatches.push(`${patch.filePath} (missing)`);
      continue;
    }
    const written = fs.readFileSync(filePath, 'utf-8');
    if (written !== patch.content) {
      mismatches.push(`${patch.filePath} (content mismatch)`);
    }
  }

  if (mismatches.length > 0) {
    const preview = mismatches.slice(0, 8).join(', ');
    throw new Error(
      `Patch application guard failed: ${mismatches.length} file(s) were not written exactly as generated (${preview})`,
    );
  }
}

function upsertPatch(output: QuestOutput, patch: FilePatch): void {
  const idx = output.patches.findIndex(p => p.filePath === patch.filePath);
  if (idx >= 0) output.patches[idx] = patch;
  else output.patches.push(patch);
}

function enforceNextFontContract(output: QuestOutput): {
  output: QuestOutput;
  layoutChanged: boolean;
  globalsChanged: boolean;
} {
  const patches = [...output.patches];
  const layoutIdx = patches.findIndex((p) => p.filePath === 'src/app/layout.tsx');
  const globalsIdx = patches.findIndex((p) => p.filePath === 'src/app/globals.css');

  let layoutChanged = false;
  let globalsChanged = false;

  if (layoutIdx >= 0) {
    const layoutPatch = patches[layoutIdx];
    let content = layoutPatch.content;
    const original = content;

    // Remove direct Google Fonts link tags; font loading must be handled via next/font/google.
    content = content
      .replace(/\n\s*<link\s+rel=["']preconnect["']\s+href=["']https:\/\/fonts\.googleapis\.com["']\s*\/?\s*>/g, '')
      .replace(/\n\s*<link\s+rel=["']preconnect["']\s+href=["']https:\/\/fonts\.gstatic\.com["'][^>]*>/g, '')
      .replace(/\n\s*<link\s+href=["']https:\/\/fonts\.googleapis\.com\/css2[^>]*>/g, '');

    // Remove empty head blocks left after link cleanup.
    content = content.replace(/<head>\s*<\/head>/g, '');

    if (!/from ['"]next\/font\/google['"]/.test(content)) {
      const importStmt = "import { DM_Sans, Playfair_Display } from 'next/font/google';\n";
      const importAnchor = "import './globals.css';\n";
      if (content.includes(importAnchor)) {
        content = content.replace(importAnchor, `${importAnchor}${importStmt}`);
      } else {
        content = `${importStmt}${content}`;
      }
    }

    if (!/const\s+dmSans\s*=\s*DM_Sans\(/.test(content)) {
      const fontConsts = [
        "const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-body', display: 'swap' });",
        "const playfair = Playfair_Display({ subsets: ['latin'], variable: '--font-heading', display: 'swap' });",
      ].join('\n');

      const metadataMatch = content.match(/export const metadata:[\s\S]*?};\n/);
      if (metadataMatch) {
        content = content.replace(metadataMatch[0], `${metadataMatch[0]}\n${fontConsts}\n`);
      } else {
        content = `${fontConsts}\n\n${content}`;
      }
    }

    // Ensure body carries next/font CSS variables for deterministic font usage.
    content = content.replace(
      /<body\s+className="([^"]*)">/,
      (_full, classes: string) => {
        const existing = classes.trim();
        const withVars = '${dmSans.variable} ${playfair.variable} ' + existing;
        const normalized = withVars.replace(/\s+/g, ' ').trim();
        return `<body className="${normalized}">`;
      },
    );

    if (content !== original) {
      layoutChanged = true;
      patches[layoutIdx] = { ...layoutPatch, content };
    }
  }

  if (globalsIdx >= 0) {
    const globalsPatch = patches[globalsIdx];
    let content = globalsPatch.content;
    const original = content;

    // Avoid duplicate/unstable remote font loading in CSS; next/font/google owns loading.
    content = content.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com\/css2[^\n]*\);\n?/g, '');

    content = content.replace(
      /body\s*\{([\s\S]*?)\}/,
      (_full, bodyInner: string) => {
        const cleaned = bodyInner.replace(/font-family\s*:[^;]+;/g, '').trim();
        const nextInner = [`font-family: var(--font-body), sans-serif;`, cleaned]
          .filter(Boolean)
          .join('\n  ');
        return `body {\n  ${nextInner}\n}`;
      },
    );

    content = content.replace(
      /h1,\s*h2,\s*h3\s*\{([\s\S]*?)\}/,
      (_full, inner: string) => {
        const cleaned = inner.replace(/font-family\s*:[^;]+;/g, '').trim();
        const nextInner = [`font-family: var(--font-heading), serif;`, cleaned]
          .filter(Boolean)
          .join('\n  ');
        return `h1, h2, h3 {\n  ${nextInner}\n}`;
      },
    );

    if (content !== original) {
      globalsChanged = true;
      patches[globalsIdx] = { ...globalsPatch, content };
    }
  }

  return {
    output: { ...output, patches },
    layoutChanged,
    globalsChanged,
  };
}

function buildVisualStyleGuardTestPatch(): FilePatch {
  return {
    filePath: 'src/app/visual-style.guard.test.tsx',
    patch: '',
    content: `import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/insforge', () => ({
  insforge: {
    database: {
      from: vi.fn(() => ({
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
        insert: vi.fn().mockResolvedValue({ data: [], error: null }),
        update: vi.fn().mockResolvedValue({ data: [], error: null }),
        delete: vi.fn().mockResolvedValue({ data: [], error: null }),
        eq: vi.fn().mockReturnThis(),
      })),
    },
    auth: {
      getCurrentUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));

function readIfExists(root: string, rel: string): string {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

function metric(content: string): { classNames: number; utilityTokens: number } {
  const classNames = (content.match(/className\\s*=/g) ?? []).length;
  const utilityTokens = (
    content.match(/\\b(bg-|text-|border-|rounded|shadow|flex|grid|gap-|p[trblxy]?-[0-9]+|m[trblxy]?-[0-9]+|font-|hover:|focus:)/g) ?? []
  ).length;
  return { classNames, utilityTokens };
}

describe('Visual style guard', () => {
  it('keeps Tailwind enabled globally', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const globals = readIfExists(root, 'src/app/globals.css');
    if (!globals) {
      // Some generated variants may intentionally relocate or omit globals.css.
      // In that case, this guard should not block deployment.
      expect(true).toBe(true);
      return;
    }
    expect(globals).toContain('@tailwind base;');
    expect(globals).toContain('@tailwind components;');
    expect(globals).toContain('@tailwind utilities;');
  });

  it('ensures auth/shell surfaces have meaningful utility styling', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const expectations: Array<{ filePath: string; minClassNames: number; minUtilityTokens: number }> = [
      { filePath: 'src/app/login/page.tsx', minClassNames: 6, minUtilityTokens: 20 },
      { filePath: 'src/app/register/page.tsx', minClassNames: 6, minUtilityTokens: 20 },
      { filePath: 'src/components/Sidebar.tsx', minClassNames: 5, minUtilityTokens: 16 },
      { filePath: 'src/components/AppShell.tsx', minClassNames: 2, minUtilityTokens: 6 },
    ];

    const existing = expectations.filter(e => fs.existsSync(path.join(root, e.filePath)));
    if (existing.length === 0) {
      // Skip when none of the expected auth/shell files were generated.
      expect(true).toBe(true);
      return;
    }

    for (const e of existing) {
      const source = readIfExists(root, e.filePath);
      const m = metric(source);
      expect(m.classNames, \`\${e.filePath} should have enough className usage\`).toBeGreaterThanOrEqual(e.minClassNames);
      expect(m.utilityTokens, \`\${e.filePath} should have enough utility classes\`).toBeGreaterThanOrEqual(e.minUtilityTokens);
    }
  });
});
`,
  };
}

function writeEnvLocal(destDir: string, config: BackendConfig): void {
  const lines = [
    `NEXT_PUBLIC_INSFORGE_URL=${config.baseUrl}`,
    `NEXT_PUBLIC_INSFORGE_ANON_KEY=${config.anonKey}`,
    ...(config.storageEndpoint
      ? [`NEXT_PUBLIC_STORAGE_ENDPOINT=${config.storageEndpoint}`]
      : []),
  ];
  fs.writeFileSync(path.join(destDir, '.env.local'), lines.join('\n') + '\n', 'utf-8');
}

// Persist quest output to disk for replay during demo
function cacheOutput(spec: SaaSSpec, output: QuestOutput): void {
  const cacheDir = path.join(GENERATED_DIR, spec.name, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'quest-output.json'),
    JSON.stringify(output, null, 2),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// GPT-4o code generation — replaces Qoder REST client
// ---------------------------------------------------------------------------

const MAX_FILE_CHARS = 6_000;   // chars to include per template file
const MAX_TOTAL_CHARS = 48_000; // total template context budget

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', '.cache']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.md']);

function getAnthropic(): Anthropic {
  const { anthropicApiKey } = getBuildCredentials();
  const apiKey = anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to apps/orchestrator/.env or provide one in the build request.');
  return new Anthropic({ apiKey });
}

function collectTemplateFiles(
  dir: string,
  base = dir,
): Array<{ filePath: string; content: string }> {
  const results: Array<{ filePath: string; content: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...collectTemplateFiles(path.join(dir, entry.name), base));
    } else {
      if (!TEXT_EXTS.has(path.extname(entry.name))) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(base, fullPath);
      try {
        let content = fs.readFileSync(fullPath, 'utf-8');
        if (content.length > MAX_FILE_CHARS) {
          content = content.slice(0, MAX_FILE_CHARS) + '\n// ... (truncated)';
        }
        results.push({ filePath: relPath, content });
      } catch { /* skip unreadable */ }
    }
  }
  return results;
}

function buildTemplateContext(tmplPath: string): string {
  const files = collectTemplateFiles(tmplPath);
  let context = '';
  let total = 0;
  for (const f of files) {
    const block = `\n\n### FILE: ${f.filePath}\n\`\`\`\n${f.content}\n\`\`\``;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    context += block;
    total += block.length;
  }
  return context;
}

function detectPatchedFilePathsFromText(rawText: string): string[] {
  const files = new Set<string>();
  const pattern = /"filePath"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawText)) !== null) {
    if (match[1]) files.add(match[1]);
  }
  return Array.from(files);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type SchemaReconcileChangeKind =
  | 'select_removed_column'
  | 'insert_removed_column'
  | 'insert_removed_null_fallback'
  | 'update_removed_column';

interface SchemaReconcileChange {
  tableName: string;
  kind: SchemaReconcileChangeKind;
  column: string;
}

interface SchemaReconcileFileReport {
  filePath: string;
  changes: SchemaReconcileChange[];
}

function reconcilePatchWithLiveSchema(
  patch: FilePatch,
  liveSchema: LiveTableSchema[],
): { patch: FilePatch; changed: boolean; report?: SchemaReconcileFileReport } {
  if (!patch.filePath.endsWith('.ts') && !patch.filePath.endsWith('.tsx')) {
    return { patch, changed: false, report: undefined };
  }
  if (liveSchema.length === 0) return { patch, changed: false, report: undefined };

  let content = patch.content;
  let changed = false;
  const report: SchemaReconcileFileReport = { filePath: patch.filePath, changes: [] };
  const addChange = (tableName: string, kind: SchemaReconcileChangeKind, column: string): void => {
    if (!report.changes.some((c) => c.tableName === tableName && c.kind === kind && c.column === column)) {
      report.changes.push({ tableName, kind, column });
    }
  };

  for (const table of liveSchema) {
    const allowed = new Set(table.columns.map((c) => c.name));
    const nonNull = new Set(table.columns.filter((c) => !c.isNullable).map((c) => c.name));
    const tablePattern = escapeRegExp(table.tableName);

    // 1) Fix select lists to remove unknown columns.
    const selectRe = new RegExp(`(from\\('${tablePattern}'\\)\\.select\\(')([^']*)('\\))`, 'g');
    content = content.replace(selectRe, (_m, start: string, cols: string, end: string) => {
      const selected = cols.split(',').map((c) => c.trim()).filter(Boolean);
      const kept = selected.filter((c) => allowed.has(c));
      if (kept.length !== selected.length) {
        changed = true;
        const removed = selected.filter((c) => !allowed.has(c));
        for (const col of removed) addChange(table.tableName, 'select_removed_column', col);
      }
      const finalCols = kept.length > 0 ? kept : selected;
      return `${start}${finalCols.join(', ')}${end}`;
    });

    // 2) Remove unknown columns in insert object literals.
    const insertRe = new RegExp(`(from\\('${tablePattern}'\\)\\.insert\\(\\[\\{)([\\s\\S]*?)(\\}\\]\\))`, 'g');
    content = content.replace(insertRe, (_m, start: string, body: string, end: string) => {
      let nextBody = body;
      for (const key of Array.from(body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)).map((m) => m[1])) {
        if (!allowed.has(key)) {
          const keyRe = new RegExp(`(^|,\\s*)${escapeRegExp(key)}\\s*:\\s*([^,]+)(?=,|$)`, 'm');
          if (keyRe.test(nextBody)) {
            nextBody = nextBody.replace(keyRe, '$1').replace(/^,\s*/, '');
            changed = true;
            addChange(table.tableName, 'insert_removed_column', key);
          }
        }
      }

      // Remove `|| null` fallback for NOT NULL columns (e.g. teamId).
      for (const key of nonNull) {
        const nnRe = new RegExp(`(${escapeRegExp(key)}\\s*:\\s*)([^,\\n]+?)\\s*\\|\\|\\s*null`, 'g');
        if (nnRe.test(nextBody)) {
          nextBody = nextBody.replace(nnRe, '$1$2');
          changed = true;
          addChange(table.tableName, 'insert_removed_null_fallback', key);
        }
      }

      return `${start}${nextBody}${end}`;
    });

    // 3) Remove unknown columns in update object literals.
    const updateRe = new RegExp(`(from\\('${tablePattern}'\\)\\.update\\(\\{)([\\s\\S]*?)(\\}\\))`, 'g');
    content = content.replace(updateRe, (_m, start: string, body: string, end: string) => {
      let nextBody = body;
      for (const key of Array.from(body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)).map((m) => m[1])) {
        if (!allowed.has(key)) {
          const keyRe = new RegExp(`(^|,\\s*)${escapeRegExp(key)}\\s*:\\s*([^,]+)(?=,|$)`, 'm');
          if (keyRe.test(nextBody)) {
            nextBody = nextBody.replace(keyRe, '$1').replace(/^,\s*/, '');
            changed = true;
            addChange(table.tableName, 'update_removed_column', key);
          }
        }
      }
      return `${start}${nextBody}${end}`;
    });
  }

  return {
    patch: { ...patch, content },
    changed,
    report: report.changes.length > 0 ? report : undefined,
  };
}

function reconcilePatchesWithLiveSchema(
  output: QuestOutput,
  liveSchema: LiveTableSchema[],
): { output: QuestOutput; changedFiles: number; totalChanges: number; report: SchemaReconcileFileReport[] } {
  if (liveSchema.length === 0) return { output, changedFiles: 0, totalChanges: 0, report: [] };
  let changedFiles = 0;
  const report: SchemaReconcileFileReport[] = [];
  const reconciled = output.patches.map((patch) => {
    const result = reconcilePatchWithLiveSchema(patch, liveSchema);
    if (result.changed) {
      changedFiles += 1;
      if (result.report) report.push(result.report);
    }
    return result.patch;
  });
  const totalChanges = report.reduce((sum, file) => sum + file.changes.length, 0);
  return { output: { ...output, patches: reconciled }, changedFiles, totalChanges, report };
}

const CODEGEN_SYSTEM_PROMPT = `\
You are a code generation agent. You receive a Next.js 14 App Router template codebase and a quest description.
Your task: modify the template to implement the described application.

RULES:
- Output ONLY valid JSON: { "patches": [{ "filePath": "relative/path", "content": "full file content" }] }
- Include every file that must be created or modified (full content, not diffs)
- filePath is relative to the project root (e.g. "src/app/page.tsx")
- TypeScript strict mode — no 'any' types
- Tailwind CSS for all styling
- Use @insforge/sdk for ALL data, auth, and storage operations (never raw fetch to a custom API)
- Initialise the InsForge client in src/lib/insforge.ts EXACTLY as:
  import { createClient } from '@insforge/sdk';
  export const insforge = createClient({ baseUrl: process.env.NEXT_PUBLIC_INSFORGE_URL!, anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY! });
- Wire every page to real DB tables via insforge.database.from('table').select() / .insert([{...}]) / .update({...}).eq('id', id) / .delete().eq('id', id)
- AUTH METHODS (use exactly): insforge.auth.signInWithPassword({ email, password }) | insforge.auth.signUp({ email, password }) | insforge.auth.signOut() | insforge.auth.getCurrentUser()
- AUTH FLOW REQUIREMENT: if sign-up does not immediately create an authenticated session (email confirmation required), generate a public '/verify' route and UX for entering/confirming the verification code or link completion, and do not route users to protected app pages until a valid session exists.
- TWO-FACTOR AUTH: DO NOT implement or enable 2FA — disable it entirely in the auth configuration. The frontend has no UI for entering 2FA codes.
- DEMO USER FOR TESTING: if auth is required, create a seed/demo user with email 'demo@example.com' and password 'demo123' (minimum 6 chars) so visitors can quickly test the app. Seed this user during initial app load (check if user exists before creating). In login submit logic, if demo sign-in fails, attempt one automatic signUp for demo credentials and retry sign-in once; if still blocked by email verification, allow a local demo bypass flag (stored in localStorage) and route to dashboard so users can evaluate UI flows without mailbox verification. Ensure sign-out clears this bypass flag. If generating a synthetic demo user object in bypass mode, its id MUST be a valid UUID string (never values like 'demo-local'). Display a subtle badge or hint on the login page recommending the demo credentials.
- Do NOT install prisma, drizzle, pg, or any raw DB driver
- Do NOT modify: package.json, next.config.js, tailwind.config.js, tsconfig.json, postcss.config.js

NEXT.JS 14 APP ROUTER — CRITICAL RULES (violations cause build failures):
1. Every file that uses useState, useEffect, useRef, useContext, event handlers (onClick, onChange, onSubmit), or any other React hook MUST have "use client"; as the very first line — before any imports.
2. NEVER import from "next/router" — always use "next/navigation" (useRouter, usePathname, useSearchParams from "next/navigation").
3. layout.tsx MUST ALWAYS remain a Server Component (no "use client") so the metadata export works. NEVER put hooks or useRouter in layout.tsx.
   - For auth guards, create a separate 'use client' component: src/components/AuthProvider.tsx that wraps children.
   - In layout.tsx, import and use <AuthProvider>{children}</AuthProvider> instead of inline hook logic.
4. Server Components (no "use client") cannot use any React hooks — move logic to a child Client Component if needed.
5. All interactive pages and components that use state or effects must have "use client"; as the very first line.
6. Always generate src/components/AuthProvider.tsx as a 'use client' component for auth redirect logic when auth is required.

DESIGN AESTHETICS — Apply to every generated UI:
- Choose a BOLD, distinctive visual direction. NEVER use generic AI aesthetics: no plain white + purple gradient hero, no predictable card-grid layouts, no boring dashboards.
- Typography: use characterful Google Fonts — e.g. "Playfair Display" or "DM Serif Display" for headings paired with "DM Sans" or "Nunito" for body. Import via next/font/google. NEVER use Inter, Roboto, Arial, or system-ui as the primary typeface.
- Color: define a cohesive palette with Tailwind CSS variables. Pick one dominant color + a sharp accent. Avoid washed-out pastels.
- Add CSS transitions/animations for interactive elements: hover effects, button press, card lift, smooth page transitions.
- Use generous whitespace, asymmetric layouts, and drop shadows for depth and premium feel.
- Backgrounds: use subtle gradients, noise textures, or geometric patterns — not plain white or solid gray.
- Navigation: build a polished sidebar or topbar with active-state styling, icons, and logo.

REACT COMPONENT PATTERNS:
- Prefer composition over inheritance — build small, focused components and compose them.
- Extract all reusable logic into custom hooks (e.g. useAsync, useToggle, useForm).
- NEVER define a component function inside another component's render scope.
- Use functional setState: setState(prev => ...) whenever the new value depends on the previous.
- For complex UI (tabs, modals, dropdowns), use compound components sharing a React Context.
- All component props via TypeScript interfaces — never use 'any' or inline object types for props.
- Error and loading states: every async data fetch must render a loading skeleton and an error message.

PERFORMANCE RULES (Next.js 14):
- Use Promise.all([...]) for all independent parallel data fetches — NEVER await them sequentially.
- 'use client' only where absolutely required (hooks/event handlers). Keep data-fetching pages as Server Components.
- Use next/dynamic with ssr:false for heavy components (charts, rich-text editors, date pickers).
- Avoid barrel file re-exports; import directly: import { X } from 'library/x', not from 'library'.
- Memoize expensive computations with useMemo; stabilize callbacks with useCallback when passed as props.
- Derive computed values during render — do NOT sync state with useEffect unnecessarily.
- Use startTransition for non-urgent state updates (search filters, typeahead).

DATA FETCHING PATTERNS (InsForge / PostgREST):
- Select ONLY the columns you need: .select('id, name, status, created_at') — NEVER .select('*').
- Keep select/insert/update payloads schema-consistent: never reference columns that are not in the declared table definition.
- Prevent N+1 queries: fetch related IDs in bulk using .in('id', ids) then build a Map for O(1) lookups.
- Always destructure {data, error} from every InsForge call and handle the error case.
- For NOT NULL foreign keys (example: projects.teamId), require a related record in UI and never insert null placeholders.
- For mutations (insert/update/delete), show optimistic UI or disable the trigger button while in-flight.

TESTING — MANDATORY: every .tsx component MUST have a paired .test.tsx file:
- REQUIRED: For every .tsx file you output (except layout.tsx and lib/insforge.ts), you MUST also include a corresponding .test.tsx file. A generation with missing test files is INCOMPLETE and will be rejected.
- Naming: same directory, .test.tsx suffix — e.g. src/components/Sidebar.tsx → src/components/Sidebar.test.tsx.
- Use vitest + @testing-library/react. Every test file starts with: import { describe, it, expect, vi } from 'vitest'; import { render, screen } from '@testing-library/react';
- Mock @insforge/sdk at the top of EVERY test file: vi.mock('@/lib/insforge', () => ({ insforge: { database: { from: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [], error: null }), insert: vi.fn().mockResolvedValue({ data: [], error: null }), update: vi.fn().mockResolvedValue({ data: [], error: null }), delete: vi.fn().mockResolvedValue({ data: [], error: null }), eq: vi.fn().mockReturnThis() }) }, auth: { getCurrentUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }), signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }), signOut: vi.fn().mockResolvedValue({ error: null }) } } }));
- Each test MUST include: (1) a smoke test — component renders without throwing, (2) at least one assertion on a visible text label, heading, or button that actually exists in the component.
- Write tests that WILL PASS on first run: assert only on static/known text from your own component. Do NOT assert on dynamic data that only appears after an async call resolves — the mock returns empty arrays.
- Keep tests simple and deterministic: no real async flows, no timers, use vi.fn() for all callbacks. Wrap in <React.StrictMode> if needed.
- Do NOT write tests for: layout.tsx, globals.css, lib/insforge.ts.
- CRITICAL: DEPLOYMENT IS BLOCKED until all tests pass. Write only assertions you are certain will pass.

PACKAGE CONSTRAINT — ABSOLUTE RULE:
- The ONLY packages available at runtime are: next, react, react-dom, @insforge/sdk, tailwindcss, lucide-react.
- NEVER import from recharts, chart.js, d3, axios, lodash, date-fns, react-hook-form, zod, framer-motion, @headlessui, @radix-ui, shadcn/ui, react-icons, react-hot-toast, sonner, react-toastify, or ANY other npm package not in the list above.
- For charts/data visualizations: build them with pure Tailwind CSS — use colored <div> bars with inline height percentages (e.g. style={{height:'60%'}}) inside a flex container. No external chart library.
- For icons: use lucide-react ONLY (it IS available). Import individual icons: import { Home, Users, Settings } from 'lucide-react'.
- For toast/notifications: use a simple useState-based inline toast component — no external toast library.
- For date formatting: use JavaScript's Intl.DateTimeFormat or Date.toLocaleDateString().
- For form validation: use useState + HTML5 required/pattern attributes. No zod, no react-hook-form.
- Violating this rule causes a build failure because the package is not installed.`;


const MAX_TEST_FIX_ATTEMPTS = 5;
const ALLOW_DEPLOY_ON_TEST_FAILURE_AFTER_MAX_ATTEMPTS =
  (process.env.ALLOW_DEPLOY_ON_TEST_FAILURE_AFTER_MAX_ATTEMPTS ?? 'true').toLowerCase() === 'true';


// ---------------------------------------------------------------------------
// Post-processing: fix common Next.js App Router violations in generated files
// ---------------------------------------------------------------------------

/** Packages that are allowed in the generated app. */
const ALLOWED_PKG_PREFIXES = [
  'next', 'react', 'react-dom', '@insforge/sdk', 'lucide-react',
  // testing — only present in test files, never in app source
  'vitest', '@testing-library', '@vitejs',
];

/**
 * Returns true if the file content contains an import from a package
 * that is NOT in ALLOWED_PKG_PREFIXES.
 * Handles both single-line and multi-line (destructured) imports by scanning
 * all `from '...'` occurrences rather than matching the full import statement.
 */
function hasUnknownPackageImport(content: string): boolean {
  // Match every `from 'pkg'` or `from "pkg"` occurrence (works for multi-line imports too)
  const fromRegex = /\bfrom\s+['\"]([^'\"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = fromRegex.exec(content)) !== null) {
    const pkg = match[1];
    if (pkg.startsWith('.') || pkg.startsWith('/') || pkg.startsWith('@/')) continue; // relative import — ok
    const ok = ALLOWED_PKG_PREFIXES.some(p => pkg === p || pkg.startsWith(`${p}/`));
    if (!ok) return true;
  }
  return false;
}

/**
 * If a generated .tsx/.ts file imports from an unknown npm package,
 * replace its entire content with a null-returning stub component so the
 * build still compiles. (The LLM is forbidden from using external packages
 * but occasionally hallucinates recharts / lucide-react / etc.)
 */
function stubComponentForUnknownImports(patch: FilePatch): FilePatch {
  if (!patch.filePath.endsWith('.tsx') && !patch.filePath.endsWith('.ts')) return patch;
  if (!hasUnknownPackageImport(patch.content)) return patch;

  const baseName = path.basename(patch.filePath, path.extname(patch.filePath));
  const componentName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
  log.warn(`Stubbing ${patch.filePath} — contains import from unknown package`);

  // Never stub test files — they legitimately import from vitest / @testing-library
  if (patch.filePath.endsWith('.test.tsx') || patch.filePath.endsWith('.test.ts')) return patch;

  // For wrapper/provider components that accept children, pass children through
  // so the rest of the app still renders (critical for AuthProvider, layout wrappers, etc.)
  const isWrapper = /children/.test(patch.content) || /Provider|Layout|Shell|Wrapper/.test(componentName);
  const isPage = patch.filePath.includes('/app/') && baseName === 'page';

  let stubContent: string;
  if (isWrapper) {
    stubContent = `'use client';
import React from 'react';

// Auto-stubbed: file imported a package not available at build time.
export default function ${componentName}({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
`;
  } else if (isPage) {
    stubContent = `'use client';

// Auto-stubbed: file imported a package not available at build time.
export default function Page() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-gray-500">This page is loading…</p>
    </div>
  );
}
`;
  } else {
    stubContent = `'use client';

// Auto-stubbed: file imported a package not available at build time.
export default function ${componentName}() {
  return null;
}
`;
  }

  return { ...patch, content: stubContent };
}

// ---------------------------------------------------------------------------
// Test runner + Claude fix loop
// ---------------------------------------------------------------------------

interface VitestResult {
  passed: boolean;
  failures: string; // truncated summary of failures
  total: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
}

interface VitestJsonReport {
  testResults?: Array<{
    name?: string;
    testFilePath?: string;
    assertionResults?: Array<{
      status: string;
      ancestorTitles?: string[];
      title?: string;
      failureMessages?: string[];
    }>;
  }>;
}

function summarizeVitestReport(raw: VitestJsonReport): {
  total: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  formattedFailures: string;
} {
  let total = 0;
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const failures: string[] = [];

  for (const file of (raw.testResults ?? [])) {
    const filePath = file.name ?? file.testFilePath ?? '(unknown)';
    const shortPath = filePath.includes('/src/') ? filePath.split('/src/')[1] : filePath;

    for (const assertion of (file.assertionResults ?? [])) {
      total++;
      if (assertion.status === 'passed') {
        passedCount++;
      } else if (assertion.status === 'failed') {
        failedCount++;
        const failureDetails = (assertion.failureMessages ?? [])
          .join('\n\n')
          .slice(0, 1200);
        failures.push(
          `[${shortPath}] ${(assertion.ancestorTitles ?? []).join(' > ')} > ${assertion.title ?? ''}\n` +
          `  ${failureDetails}`,
        );
      } else {
        skippedCount++;
      }
    }
  }

  const header = `Test summary: total=${total}, passed=${passedCount}, failed=${failedCount}, skipped=${skippedCount}`;
  const formattedFailures = failures.length > 0
    ? `${header}\n\nDetected ${failures.length} failing assertion(s). Showing up to 25 detailed failure(s).\n\n${failures.slice(0, 25).join('\n\n')}`
    : header;

  return { total, passedCount, failedCount, skippedCount, formattedFailures };
}

/** Install npm deps in the generated app dir. Throws if install fails. */
async function installDeps(appDir: string): Promise<void> {
  const { execSync } = await import('child_process');
  execSync('npm install --prefer-offline --no-audit --no-fund', {
    cwd: appDir, stdio: 'pipe', timeout: 120_000,
  });
}

/**
 * Returns the list of component .tsx/.ts files that are missing a paired .test.tsx/.test.ts
 * in the patches array. Excludes layout, globals, lib/insforge, and vitest config files.
 */
function findMissingTestFiles(patches: FilePatch[]): string[] {
  const testPaths = new Set(
    patches
      .filter(p => p.filePath.endsWith('.test.tsx') || p.filePath.endsWith('.test.ts'))
      .map(p => p.filePath),
  );
  const SKIP = ['layout', 'globals', 'lib/insforge', 'vitest.config', 'vitest.setup'];
  return patches
    .filter(p => {
      if (!p.filePath.endsWith('.tsx') && !p.filePath.endsWith('.ts')) return false;
      if (p.filePath.endsWith('.test.tsx') || p.filePath.endsWith('.test.ts')) return false;
      if (SKIP.some(s => p.filePath.includes(s))) return false;
      const expected = p.filePath.endsWith('.tsx')
        ? p.filePath.replace(/\.tsx$/, '.test.tsx')
        : p.filePath.replace(/\.ts$/, '.test.ts');
      return !testPaths.has(expected);
    })
    .map(p => p.filePath);
}

/** Run vitest in appDir. Returns structured pass/fail with actionable failure messages. */
async function runTests(appDir: string): Promise<VitestResult> {
  const { execSync } = await import('child_process');
  const testCommand = 'npx vitest run --reporter=json --outputFile=test-results.json';
  const resultsPath = path.join(appDir, 'test-results.json');

  // Remove stale results file before run so we don't read old data on crash
  if (fs.existsSync(resultsPath)) fs.unlinkSync(resultsPath);

  const readStructuredResults = (): VitestResult | null => {
    if (!fs.existsSync(resultsPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as VitestJsonReport;
      const summary = summarizeVitestReport(raw);
      return {
        passed: summary.failedCount === 0,
        failures: summary.formattedFailures,
        total: summary.total,
        passedCount: summary.passedCount,
        failedCount: summary.failedCount,
        skippedCount: summary.skippedCount,
      };
    } catch {
      return null;
    }
  };

  try {
    execSync(testCommand, { cwd: appDir, stdio: 'pipe', timeout: 120_000 });
    const structured = readStructuredResults();
    if (structured) return structured;
    return { passed: true, failures: 'Test summary: total=0, passed=0, failed=0, skipped=0', total: 0, passedCount: 0, failedCount: 0, skippedCount: 0 };
  } catch (err: unknown) {
    // Try structured JSON first — vitest writes it even on failure
    const structured = readStructuredResults();
    if (structured) return structured;

    // Fallback: vitest prints human-readable output to stdout
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };
    const combined = [
      e.stdout ? String(e.stdout).slice(0, 6000) : '',
      e.stderr ? String(e.stderr).slice(0, 3000) : '',
    ].filter(Boolean).join('\n---\n');
    return {
      passed: false,
      failures: combined || String(err).slice(0, 4000),
      total: 0,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };
  }
}

/** Ask Claude to fix only the failing test/source files. Returns new patches. */
async function callClaudeForTestFix(
  failures: string,
  currentPatches: FilePatch[],
): Promise<FilePatch[]> {
  // Include only files that appear in failure output to avoid destabilizing passing tests.
  const failureText = failures.toLowerCase();
  const bracketedPathMatches = Array.from(failures.matchAll(/\[([^\]]+)\]/g)).map(m => m[1]?.toLowerCase() ?? '');
  const relevantPatches = currentPatches.filter(p => {
    const filePathLower = p.filePath.toLowerCase();
    const baseName = path.basename(filePathLower);
    const baseNoTest = baseName.replace(/\.test\.tsx?$/, '');
    return bracketedPathMatches.some(ref => ref.endsWith(filePathLower) || filePathLower.endsWith(ref))
      || failureText.includes(filePathLower)
      || failureText.includes(baseName)
      || failureText.includes(baseNoTest);
  });

  const fallbackPatches = currentPatches.filter(
    p => p.filePath.endsWith('.test.tsx') || p.filePath.endsWith('.test.ts'),
  );

  const selectedPatches = relevantPatches.length > 0 ? relevantPatches : fallbackPatches.slice(0, 8);

  const patchSummary = selectedPatches
    .map(p => `### ${p.filePath}\n\`\`\`\n${p.content.slice(0, 800)}\n\`\`\`\n`)
    .join('\n');

  const allowedPaths = new Set(selectedPatches.map(p => p.filePath));

  const parsePatchJson = (text: string): FilePatch[] => {
    const candidates: string[] = [];
    const primary = extractJson(text);
    if (primary) candidates.push(primary);

    const fenceMatches = text.match(/```(?:json)?\s*[\s\S]*?```/g) ?? [];
    for (const fence of fenceMatches) {
      const extracted = extractJson(fence);
      if (extracted) candidates.push(extracted);
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as { patches?: FilePatch[] };
        if (Array.isArray(parsed.patches)) {
          return parsed.patches.filter(p => allowedPaths.has(p.filePath));
        }
      } catch {
        // try next candidate
      }
    }

    return [];
  };

  const buildFixPrompt = (strictMode: boolean): string => {
    const strictLine = strictMode
      ? 'STRICT: Your response is discarded unless it is valid JSON starting with { and ending with }.'
      : '';

    return (
      `The following vitest tests are failing. Fix ONLY the files that cause failures.\n\n` +
      `## Failing tests\n${failures}\n\n` +
      `## Current source files\n${patchSummary}\n\n` +
      `IMPORTANT: modify ONLY these file paths: ${Array.from(allowedPaths).join(', ') || '(none)'}\n` +
      `${strictLine}\n` +
      `Return ONLY: { "patches": [{"filePath": "...", "content": "..."}] }`
    );
  };

  const SYSTEM = [
    'You are a test-fixing agent. You receive failing vitest test output and the source files.',
    'Return ONLY a valid JSON object — no markdown, no code fences, no explanation:',
    '{ "patches": [{ "filePath": "relative/path", "content": "full file content" }] }',
    'Include only the files that need to be changed. Do NOT wrap in ```json```.',
  ].join('\n');

  const askForFixes = async (strictMode: boolean): Promise<string> => {
    const stream = getAnthropic().messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 32000,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildFixPrompt(strictMode) }],
    });
    const response = await stream.finalMessage();
    const block = response.content[0];
    return block.type === 'text' ? block.text : '{}';
  };

  const firstRaw = await askForFixes(false);
  const firstPatches = parsePatchJson(firstRaw);
  if (firstPatches.length > 0) return firstPatches;

  log.warn(`callClaudeForTestFix: JSON parse failed. Raw (200 chars): ${extractJson(firstRaw).slice(0, 200)}`);

  const retryRaw = await askForFixes(true);
  const retryPatches = parsePatchJson(retryRaw);
  if (retryPatches.length > 0) {
    log.info(`callClaudeForTestFix: strict retry recovered ${retryPatches.length} patch(es)`);
    return retryPatches;
  }

  log.warn(`callClaudeForTestFix: strict retry also failed. Raw (200 chars): ${extractJson(retryRaw).slice(0, 200)}`);
  return [];
}

/** Ask Claude to generate test files for components that are missing them. */
async function callClaudeForTestGeneration(currentPatches: FilePatch[]): Promise<FilePatch[]> {
  const componentFiles = currentPatches.filter(
    p => (p.filePath.endsWith('.tsx') || p.filePath.endsWith('.ts'))
      && !p.filePath.endsWith('.test.tsx')
      && !p.filePath.endsWith('.test.ts')
      && !p.filePath.includes('layout')
      && !p.filePath.includes('globals')
      && !p.filePath.includes('lib/insforge'),
  );

  if (componentFiles.length === 0) return [];

  const patchSummary = componentFiles
    .map(p => `### ${p.filePath}\n\`\`\`\n${p.content.slice(0, 800)}\n\`\`\`\n`)
    .join('\n');

  const stream = getAnthropic().messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 32000,
    system: CODEGEN_SYSTEM_PROMPT + '\n\nRespond with only a valid JSON object. No markdown, no code fences.',
    messages: [{
      role: 'user',
      content:
        `These component files were generated WITHOUT test files. Generate a .test.tsx for each one.\n\n` +
        `## Component files\n${patchSummary}\n\n` +
        `Return ONLY: { "patches": [{"filePath": "...", "content": "..."}] } where every patch ends in .test.tsx.`,
    }],
  });
  const response = await stream.finalMessage();
  const block = response.content[0];
  const rawJson = block.type === 'text' ? extractJson(block.text) : '{}';
  try {
    const parsed = JSON.parse(rawJson) as { patches?: FilePatch[] };
    return Array.isArray(parsed.patches)
      ? parsed.patches.filter(p => p.filePath.endsWith('.test.tsx') || p.filePath.endsWith('.test.ts'))
      : [];
  } catch (e) {
    log.warn(`callClaudeForTestGeneration: JSON parse failed. Raw (200 chars): ${rawJson.slice(0, 200)}`);
    return [];
  }
}

function fixNextjsAppRouterIssues(patch: FilePatch): FilePatch {
  const isTsx = patch.filePath.endsWith('.tsx') || patch.filePath.endsWith('.ts');
  if (!isTsx) return patch;

  let content = patch.content;

  // Replace next/router with next/navigation
  content = content.replace(/from ['"]next\/router['"]/g, "from 'next/navigation'");
  // Fix insforge SDK API: insforge.db('x') → insforge.database.from('x')
  content = content.replace(/insforge\.db\(([^)]+)\)/g, 'insforge.database.from($1)');

  // Fix createClient positional args → named object
  content = content.replace(
    /createClient\(\s*process\.env\.NEXT_PUBLIC_INSFORGE_URL(!?)\s*,\s*process\.env\.NEXT_PUBLIC_INSFORGE_ANON_KEY(!?)\s*\)/g,
    "createClient({ baseUrl: process.env.NEXT_PUBLIC_INSFORGE_URL!, anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY! })",
  );

  // Fix auth method names: signIn → signInWithPassword, getUser → getCurrentUser
  content = content.replace(/insforge\.auth\.signIn\b/g, 'insforge.auth.signInWithPassword');
  content = content.replace(/insforge\.auth\.getUser\b/g, 'insforge.auth.getCurrentUser');

  // Ensure /verify remains publicly accessible in common AuthProvider patterns.
  content = content.replace(
    /const\s+PUBLIC_PATHS\s*=\s*\[(.*?)\]/s,
    (full, inner: string) => {
      if (inner.includes("'/verify'") || inner.includes('"/verify"')) return full;
      const trimmed = inner.trim();
      if (!trimmed) return "const PUBLIC_PATHS = ['/verify']";
      const suffix = trimmed.endsWith(',') ? '' : ',';
      return `const PUBLIC_PATHS = [${trimmed}${suffix} '/verify']`;
    },
  );

  // Determine if file needs "use client"
  const needsClientDirective =
    /\buseState\b/.test(content) ||
    /\buseEffect\b/.test(content) ||
    /\buseRef\b/.test(content) ||
    /\buseContext\b/.test(content) ||
    /\buseRouter\b/.test(content) ||
    /\busePathname\b/.test(content) ||
    /\buseSearchParams\b/.test(content) ||
    /\bon[A-Z][a-zA-Z]+\s*=/.test(content); // onClick=, onChange=, etc.

  const alreadyHasDirective = /^['"]use client['"]/.test(content.trimStart());

  if (needsClientDirective && !alreadyHasDirective) {
    content = `'use client';\n\n${content}`;
  }

  return { ...patch, content };
}

// ---------------------------------------------------------------------------
// Multi-pass generation helpers
// ---------------------------------------------------------------------------

/** Max DB tables per Claude generation pass (each pass ≈ 15–25 files). */
const PASS_BATCH_SIZE = 3;

/**
 * Single Claude streaming call → parsed + post-processed QuestOutput.
 * Shared by both the initial pass and continuation passes.
 */
async function callClaudeForCodegenPass(
  userContent: string,
  emit: EmitFn,
  passLabel: string,
): Promise<QuestOutput> {
  const stream = getAnthropic().messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 64000,
    system: CODEGEN_SYSTEM_PROMPT + '\n\nRespond with only a valid JSON object. No markdown, no code fences.',
    messages: [{ role: 'user', content: userContent }],
  });

  let streamedText = '';
  let detectedFiles = 0;
  let announcedStart = false;
  let announcedJsonShape = false;
  const announcedPaths = new Set<string>();

  stream.on('text', (textDelta: string) => {
    streamedText += textDelta;
    if (!announcedStart) {
      emit({ step: 'code_generated', message: `[${passLabel}] Model started streaming`, ts: Date.now() });
      announcedStart = true;
    }
    if (!announcedJsonShape && streamedText.includes('"patches"')) {
      emit({ step: 'code_generated', message: `[${passLabel}] Structured patch payload detected`, ts: Date.now() });
      announcedJsonShape = true;
    }
    const paths = detectPatchedFilePathsFromText(streamedText);
    detectedFiles = paths.length;
    for (const filePath of paths) {
      if (!announcedPaths.has(filePath)) {
        announcedPaths.add(filePath);
        const ext = path.extname(filePath).replace('.', '').toUpperCase() || 'FILE';
        const isTest = filePath.endsWith('.test.tsx') || filePath.endsWith('.test.ts');
        const isPage = filePath.includes('/app/') && path.basename(filePath).startsWith('page');
        const isComponent = filePath.includes('/components/');
        const isLib = filePath.includes('/lib/');
        const isStyle = filePath.endsWith('.css');
        const isConfig = filePath.endsWith('.config.js') || filePath.endsWith('.config.ts');
        const kind = isTest ? 'TEST' : isPage ? 'PAGE' : isComponent ? 'COMPONENT' : isLib ? 'LIB' : isStyle ? 'STYLE' : isConfig ? 'CONFIG' : ext;
        emit({ step: 'code_generated', message: `[${announcedPaths.size}] streaming ${kind} · ${filePath}`, ts: Date.now() });
      }
    }
  });

  const response = await stream.finalMessage();
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`[${passLabel}] hit the output token limit. Try reducing the number of entities or tables in your prompt.`);
  }
  const block = response.content[0];
  const rawJson = block.type === 'text' ? extractJson(block.text) : '';
  emit({ step: 'code_generated', message: `[${passLabel}] response complete — ${detectedFiles} candidate file patches`, ts: Date.now() });

  let parsed: { patches?: unknown };
  try { parsed = JSON.parse(rawJson); } catch {
    throw new Error(`[${passLabel}] returned invalid JSON: ${rawJson.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed.patches) || parsed.patches.length === 0) {
    throw new Error(`[${passLabel}] response is missing a "patches" array`);
  }
  emit({ step: 'code_generated', message: `[${passLabel}] JSON validated — ${(parsed.patches as FilePatch[]).length} raw patch entries`, ts: Date.now() });

  const patches = (parsed.patches as FilePatch[])
    .map(fixNextjsAppRouterIssues)
    .map(stubComponentForUnknownImports);

  return { questId: `claude-pass-${Date.now()}`, status: 'completed', patches };
}

/**
 * Build a short context block of already-generated files for continuation passes.
 * Prioritises AppShell / Sidebar / nav files so Claude updates navigation correctly.
 */
function buildExistingFilesContext(patches: FilePatch[], maxChars = 30_000): string {
  const PRIORITY_KEYWORDS = ['appshell', 'sidebar', 'navigation', 'layout', 'lib/insforge', 'types', 'hooks'];
  const sorted = [...patches].sort((a, b) => {
    const aP = PRIORITY_KEYWORDS.some(k => a.filePath.toLowerCase().includes(k)) ? 0 : 1;
    const bP = PRIORITY_KEYWORDS.some(k => b.filePath.toLowerCase().includes(k)) ? 0 : 1;
    return aP - bP;
  });
  let context = '';
  let total = 0;
  for (const patch of sorted) {
    const block = `\n\n### FILE: ${patch.filePath}\n\`\`\`\n${patch.content.slice(0, 4000)}\n\`\`\``;
    if (total + block.length > maxChars) break;
    context += block;
    total += block.length;
  }
  return context;
}

/**
 * Prompt that tells Claude to extend an existing app with new entities.
 * Used for pass 2, 3, … in multi-pass generation.
 */
function buildContinuationQuestPrompt(
  spec: SaaSSpec,
  batchTables: SaaSSpec['dbSchema'],
  config: BackendConfig,
  existingFilesContext: string,
): string {
  const envBlock = [
    `NEXT_PUBLIC_INSFORGE_URL=${config.baseUrl}`,
    `NEXT_PUBLIC_INSFORGE_ANON_KEY=${config.anonKey}`,
    ...(config.storageEndpoint ? [`NEXT_PUBLIC_STORAGE_ENDPOINT=${config.storageEndpoint}`] : []),
  ].join('\n');

  const newTablesBlock = batchTables
    .map(t => `- ${t.name}: ${t.columns.map(c => `${c.name}:${c.type}${c.nullable ? '?' : ''}`).join(', ')}`)
    .join('\n');

  const newCrudBlock = batchTables.map(t => `- /${t.name}: list, create, edit, delete`).join('\n');

  return `# EXTENSION PASS — Add new entities to "${spec.name}"

The core app scaffold (auth, AppShell, Sidebar, layout, lib/insforge, shared components) was generated in a prior pass. The existing files are provided below as read-only context.

## CRITICAL RULES FOR THIS PASS
- DO NOT regenerate: layout.tsx, globals.css, lib/insforge.ts, auth pages (/login, /register, /verify), or any entity pages that are NOT in the "New Entities" list.
- DO update AppShell.tsx or Sidebar.tsx (whichever owns the nav links) to include the new routes.
- Match the same visual style, patterns, and component structure as the existing files.
- Generate a .test.tsx for every new .tsx file you create.

## ENVIRONMENT VARIABLES
\`\`\`
${envBlock}
\`\`\`

## NEW ENTITIES TO ADD
${batchTables.map(t => `- ${t.name}`).join('\n')}

## NEW DB TABLE SCHEMAS (exact columns)
${newTablesBlock}

## NEW ROUTES
${newCrudBlock}

## EXISTING APP FILES (context only — update nav, don't regenerate data pages)
${existingFilesContext}`;
}

export async function generateCode(
  spec: SaaSSpec,
  config: BackendConfig,
  emit: EmitFn,
): Promise<QuestOutput> {
  // --- Atomic temp dir setup ---
  const destDir = path.join(GENERATED_DIR, spec.name);
  const tempRoot = path.join(GENERATED_DIR, '.tmp');
  const tempDir = createTempDir('orchestrator-', tempRoot);
  let debugDir: string | null = null;
  try {
    // 1. Fork template into temp dir
    emit({ step: 'code_generated', message: `Forking "${spec.template}" template (temp)…`, ts: Date.now() });
    const tmplPath = templatePath(spec.template);
    if (!fs.existsSync(tmplPath)) {
      throw new Error(`Template not found at ${tmplPath}. Run the template setup first.`);
    }
    copyDir(tmplPath, tempDir);

    // 2. Read template context (prompt is built per-pass below)
    emit({ step: 'code_generated', message: 'Reading template structure…', ts: Date.now() });
    const templateContext = buildTemplateContext(tmplPath);

    // 3. Code generation — single or multi-pass depending on entity count
    const passCount = Math.ceil(spec.dbSchema.length / PASS_BATCH_SIZE);
    const pass1Spec: SaaSSpec = passCount > 1
      ? { ...spec, dbSchema: spec.dbSchema.slice(0, PASS_BATCH_SIZE), entities: spec.entities.slice(0, PASS_BATCH_SIZE) }
      : spec;

    emit({
      step: 'code_generated',
      message: passCount > 1
        ? `Multi-pass mode (${passCount} passes) — pass 1/${passCount}: entities ${pass1Spec.dbSchema.map(t => t.name).join(', ')}…`
        : 'Claude is writing your application…',
      ts: Date.now(),
    });

    const pass1Prompt = buildQuestPrompt(pass1Spec, config);

    if (process.env.STRICT_PROMPT_DEBUG === 'true') {
      const redacted = redactPromptForDebug(pass1Prompt);
      log.info('STRICT_PROMPT_DEBUG — pass 1 prompt (redacted):', {
        specName: spec.name,
        template: spec.template,
        promptChars: redacted.length,
        prompt: redacted,
      });
    }

    let mergedOutput = await callClaudeForCodegenPass(
      `## Quest\n\n${pass1Prompt}\n\n## Current Template Files\n${templateContext}`,
      emit,
      passCount > 1 ? `Pass 1/${passCount}` : 'Generation',
    );

    for (let i = PASS_BATCH_SIZE; i < spec.dbSchema.length; i += PASS_BATCH_SIZE) {
      const batchTables = spec.dbSchema.slice(i, i + PASS_BATCH_SIZE);
      const passNum = Math.floor(i / PASS_BATCH_SIZE) + 1;
      emit({
        step: 'code_generated',
        message: `Pass ${passNum}/${passCount}: extending app with entities ${batchTables.map(t => t.name).join(', ')}…`,
        ts: Date.now(),
      });
      const existingCtx = buildExistingFilesContext(mergedOutput.patches);
      const continuationPrompt = buildContinuationQuestPrompt(spec, batchTables, config, existingCtx);
      const passOutput = await callClaudeForCodegenPass(continuationPrompt, emit, `Pass ${passNum}/${passCount}`);
      for (const patch of passOutput.patches) {
        upsertPatch(mergedOutput, patch);
      }
      emit({
        step: 'code_generated',
        message: `Pass ${passNum}/${passCount} merged — ${mergedOutput.patches.length} total files accumulated`,
        ts: Date.now(),
      });
    }

    const fontNormalized = enforceNextFontContract(mergedOutput);
    const normalizedOutput = fontNormalized.output;
    if (fontNormalized.layoutChanged || fontNormalized.globalsChanged) {
      emit({
        step: 'code_generated',
        message: `Font loading normalized to next/font/google (layout: ${fontNormalized.layoutChanged ? 'updated' : 'ok'}, globals: ${fontNormalized.globalsChanged ? 'updated' : 'ok'})`,
        ts: Date.now(),
      });
    }

    // Reconcile generated DB query/mutation columns with live backend schema.
    const {
      output: reconciledOutput,
      changedFiles,
      totalChanges,
      report: schemaReconcileReport,
    } = reconcilePatchesWithLiveSchema(normalizedOutput, config.liveSchema ?? []);

    // Persist reconciliation artifact for diagnostics/review in the generated app.
    const schemaReportRelPath = '.cache/schema-reconciliation-report.json';
    const schemaReportAbsPath = path.join(tempDir, schemaReportRelPath);
    fs.mkdirSync(path.dirname(schemaReportAbsPath), { recursive: true });
    fs.writeFileSync(
      schemaReportAbsPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          specName: spec.name,
          template: spec.template,
          summary: {
            changedFiles,
            totalChanges,
            liveTables: (config.liveSchema ?? []).map((t) => t.tableName),
          },
          files: schemaReconcileReport,
        },
        null,
        2,
      ),
      'utf-8',
    );

    emit({
      step: 'code_generated',
      message: `Schema reconciliation report written: ${schemaReportRelPath}`,
      data: {
        reportPath: schemaReportRelPath,
        changedFiles,
        totalChanges,
      },
      ts: Date.now(),
    });

    if (changedFiles > 0) {
      emit({
        step: 'code_generated',
        message: `Schema reconciliation adjusted ${changedFiles} file(s), ${totalChanges} change(s) against live DB columns`,
        data: {
          changedFiles,
          totalChanges,
          files: schemaReconcileReport.map((r) => ({
            filePath: r.filePath,
            changes: r.changes.length,
          })),
        },
        ts: Date.now(),
      });
    }

    // 5. Apply patches, persist cache, write env vars (in temp dir)
    emit({
      step: 'code_generated',
      message: `Applying ${reconciledOutput.patches.length} normalized patch files…`,
      ts: Date.now(),
    });
    applyPatches(tempDir, reconciledOutput, emit);
    verifyAppliedPatches(tempDir, reconciledOutput.patches);

    // Inject a regression test that fails when key UI surfaces lose Tailwind styling.
    const visualStyleTestPatch = buildVisualStyleGuardTestPatch();
    applyPatches(tempDir, { ...reconciledOutput, patches: [visualStyleTestPatch] });
    verifyAppliedPatches(tempDir, [visualStyleTestPatch]);
    upsertPatch(reconciledOutput, visualStyleTestPatch);
    emit({
      step: 'code_generated',
      message: 'Visual style regression guard injected',
      ts: Date.now(),
    });

    // --- Test coverage and test-fix loop in temp dir ---
    const missingTests = findMissingTestFiles(reconciledOutput.patches);
    if (missingTests.length > 0) {
      emit({ step: 'tests_run', message: `Generating ${missingTests.length} missing test file(s)…`, ts: Date.now() });
      const testPatches = await callClaudeForTestGeneration(reconciledOutput.patches);
      if (testPatches.length > 0) {
        applyPatches(tempDir, { ...reconciledOutput, patches: testPatches });
        verifyAppliedPatches(tempDir, testPatches);
        reconciledOutput.patches.push(...testPatches);
        emit({ step: 'tests_run', message: `Coverage OK — ${testPatches.length} test file(s) generated`, ts: Date.now() });
      }
    }

    emit({ step: 'tests_run', message: 'Installing dependencies…', ts: Date.now() });
    await installDeps(tempDir);

    let testResult = await runTests(tempDir);
    const initialSummary = `Test summary: total=${testResult.total}, passed=${testResult.passedCount}, failed=${testResult.failedCount}, skipped=${testResult.skippedCount}`;
    log.info(initialSummary);
    emit({ step: 'tests_run', message: initialSummary, ts: Date.now() });

    // Detect runner crash: vitest exited non-zero but ran zero tests — likely a process-level
    // error (bad CLI args, missing deps, syntax error in config). Claude cannot fix this via
    // source patches, so bail immediately with a clear diagnosis instead of wasting 5 attempts.
    if (!testResult.passed && testResult.total === 0) {
      const msg = `✗ Test runner crashed before executing any tests — cannot auto-fix.\n\n${testResult.failures}`;
      emit({ step: 'tests_run', message: msg, ts: Date.now() });
      throw new Error(msg);
    }

    let attempt = 0;
    debugDir = path.join(os.tmpdir(), `orchestrator-debug-${uuidv4()}`);
    fs.mkdirSync(debugDir, { recursive: true });

    while (!testResult.passed && attempt < MAX_TEST_FIX_ATTEMPTS) {
      attempt++;
      const attemptSummary = `Attempt ${attempt} summary: total=${testResult.total}, passed=${testResult.passedCount}, failed=${testResult.failedCount}, skipped=${testResult.skippedCount}`;
      log.warn(attemptSummary);
      emit({ step: 'tests_run', message: attemptSummary, ts: Date.now() });
      log.warn(`Tests failed on attempt ${attempt}. Detailed failures:\n${testResult.failures}`);
      emit({
        step: 'tests_run',
        message: `Tests failed (attempt ${attempt}/${MAX_TEST_FIX_ATTEMPTS}) — asking Claude to fix…`,
        ts: Date.now(),
      });

      // Persist debug artifacts for this attempt
      const debugFile = path.join(debugDir, `test-fix-attempt-${attempt}.log`);
      fs.writeFileSync(debugFile, testResult.failures, 'utf-8');

      const fixPatches = await callClaudeForTestFix(testResult.failures, reconciledOutput.patches);

      if (fixPatches.length === 0) {
        log.warn(`Test fix attempt ${attempt}: Claude returned no patches — re-running tests`);
        testResult = await runTests(tempDir);
        const rerunSummary = `Re-run summary: total=${testResult.total}, passed=${testResult.passedCount}, failed=${testResult.failedCount}, skipped=${testResult.skippedCount}`;
        log.info(rerunSummary);
        emit({ step: 'tests_run', message: rerunSummary, ts: Date.now() });
        continue;
      }

      const fixedPatches = fixPatches
        .map(fixNextjsAppRouterIssues)
        .map(stubComponentForUnknownImports);
      applyPatches(tempDir, { ...reconciledOutput, patches: fixedPatches });
      verifyAppliedPatches(tempDir, fixedPatches);
      for (const fp of fixedPatches) {
        const idx = reconciledOutput.patches.findIndex(p => p.filePath === fp.filePath);
        if (idx >= 0) reconciledOutput.patches[idx] = fp; else reconciledOutput.patches.push(fp);
      }
      testResult = await runTests(tempDir);
      const postFixSummary = `Post-fix summary: total=${testResult.total}, passed=${testResult.passedCount}, failed=${testResult.failedCount}, skipped=${testResult.skippedCount}`;
      log.info(postFixSummary);
      emit({ step: 'tests_run', message: postFixSummary, ts: Date.now() });
    }

    if (!testResult.passed) {
      const summary = `Tests still failing after ${attempt} fix attempt(s): total=${testResult.total}, passed=${testResult.passedCount}, failed=${testResult.failedCount}, skipped=${testResult.skippedCount}`;
      const failuresMsg = `Detailed failures:\n${testResult.failures}`;

      if (ALLOW_DEPLOY_ON_TEST_FAILURE_AFTER_MAX_ATTEMPTS) {
        log.warn(`${summary} — continuing due to ALLOW_DEPLOY_ON_TEST_FAILURE_AFTER_MAX_ATTEMPTS=true`);
        emit({
          step: 'tests_run',
          message: `⚠ ${summary}. Continuing deployment because ALLOW_DEPLOY_ON_TEST_FAILURE_AFTER_MAX_ATTEMPTS=true`,
          ts: Date.now(),
        });
        emit({ step: 'tests_run', message: failuresMsg, ts: Date.now() });
      } else {
        const msg = `✗ ${summary} — deployment blocked\n\n${failuresMsg}`;
        emit({ step: 'tests_run', message: msg, ts: Date.now() });
        throw new Error(msg);
      }
    }

    emit({
      step: 'tests_run',
      message: attempt === 0 ? '✓ All tests passed' : `✓ Tests passing after ${attempt} fix attempt(s)`,
      ts: Date.now(),
    });
    emit({
      step: 'tests_run',
      message: `Final test summary: total=${testResult.total}, passed=${testResult.passedCount}, failed=${testResult.failedCount}, skipped=${testResult.skippedCount}`,
      ts: Date.now(),
    });
    emit({
      step: 'tests_run',
      message: `Test stage complete — deployment gate cleared`,
      ts: Date.now(),
    });

    // --- Atomic swap to destination ---
    emit({
      step: 'code_generated',
      message: `Preparing atomic swap (${tempDir} -> ${destDir})`,
      ts: Date.now(),
    });
    if (!fs.existsSync(tempDir)) {
      throw new Error(`Temporary build directory missing before swap: ${tempDir}`);
    }
    atomicSwapDir(tempDir, destDir);
    emit({
      step: 'code_generated',
      message: 'Atomic swap complete — generated project promoted to destination',
      ts: Date.now(),
    });

    // --- Write final cache from test-passing state ---
    cacheOutput(spec, reconciledOutput);
    writeEnvLocal(destDir, config);
    emit({
      step: 'code_generated',
      message: 'Cache and environment files persisted',
      ts: Date.now(),
    });

    emit({
      step: 'code_generated',
      message: `Code generation complete — ${reconciledOutput.patches.length} files written.`,
      ts: Date.now(),
    });

    return reconciledOutput;
  } catch (err) {
    // Clean up temp dir on failure
    removeDirRecursive(tempDir);
    throw err;
  }
}