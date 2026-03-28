/**
 * Qoder Quest SDK — thin wrapper.
 *
 * Qoder Quest Mode accepts a repo + prompt and streams back file diff chunks
 * until the quest is complete.
 *
 * NOTE: @qoder/sdk is not published to npm. This fetch + ReadableStream
 * implementation is intentional and complete — do not attempt to replace it.
 */

const BASE_URL = 'https://api.qoder.dev/v1';
const API_KEY = process.env.QODER_API_KEY ?? '';

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
}

// ---------------------------------------------------------------------------
// Start a quest
// ---------------------------------------------------------------------------

export interface StartQuestOptions {
  repoPath: string;   // absolute local path OR GitHub URL
  prompt: string;
  branch?: string;
}

export interface QuestStartResult {
  questId: string;
  status: 'queued' | 'running';
}

export async function startQuest(opts: StartQuestOptions): Promise<QuestStartResult> {
  const res = await fetch(`${BASE_URL}/quests`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      repo: opts.repoPath,
      prompt: opts.prompt,
      branch: opts.branch ?? 'main',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qoder startQuest failed (${res.status}): ${text}`);
  }

  return (await res.json()) as QuestStartResult;
}

// ---------------------------------------------------------------------------
// Stream quest progress
// ---------------------------------------------------------------------------

export type QuestStreamCallback = (message: string) => void;

export async function streamQuest(
  questId: string,
  onMessage: QuestStreamCallback,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/quests/${questId}/stream`, {
    method: 'GET',
    headers: { ...headers(), Accept: 'text/event-stream' },
  });

  if (!res.ok || !res.body) {
    throw new Error(`Qoder streamQuest failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload && payload !== '[DONE]') {
          onMessage(payload);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Get completed diff
// ---------------------------------------------------------------------------

export interface FilePatch {
  filePath: string;
  patch: string;      // unified diff
  content: string;    // full new file content
}

export interface QuestOutput {
  questId: string;
  status: 'completed' | 'failed';
  patches: FilePatch[];
}

export async function getQuestOutput(questId: string): Promise<QuestOutput> {
  const res = await fetch(`${BASE_URL}/quests/${questId}/output`, {
    headers: headers(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qoder getQuestOutput failed (${res.status}): ${text}`);
  }

  return (await res.json()) as QuestOutput;
}
