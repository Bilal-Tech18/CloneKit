// Lancement d'un agent de correction (Claude Code en mode non interactif) dans un bac à sable :
// - outils de fichiers confinés au dossier du clone (--restricted) : le code de l'original est illisible ;
// - shell limité à curl (interroger l'original en boîte noire) et `node --check` ;
// - tout le reste est refusé sans question (dontAsk) ; budget plafonné.
// Chaque appel d'outil est journalisé puis audité.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface AgentOptions {
  cwd: string;
  prompt: string;
  logFile: string;
  budgetUsd: number;
  model?: string;
  timeoutMs?: number;
  /** Commandes shell interdites en plus de la liste blanche (ex. télécharger le JS de l'original). */
  denyBash?: RegExp[];
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  denied: boolean;
  /** Violation des règles du bac à sable (tentative hors dossier, commande non autorisée…). */
  violation?: string;
}

export interface AgentRun {
  ok: boolean;
  summary: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  toolCalls: ToolCall[];
  stopReason: string;
}

const ALLOWED_BASH = [/^curl\b/, /^node --check\b/];

function audit(call: { name: string; input: Record<string, unknown> }, cwd: string, denyBash: RegExp[] = []): string | undefined {
  const path = (call.input.file_path ?? call.input.path) as string | undefined;
  if (path) {
    const rel = relative(cwd, isAbsolute(path) ? path : resolve(cwd, path));
    if (rel.startsWith('..') || isAbsolute(rel)) return `accès hors du dossier du clone : ${path}`;
  }
  if (call.name === 'Bash') {
    const cmd = String(call.input.command ?? '').trim();
    if (!ALLOWED_BASH.some((re) => re.test(cmd))) return `commande non autorisée : ${cmd.slice(0, 80)}`;
    if (denyBash.some((re) => re.test(cmd))) return `commande interdite pour cette tâche : ${cmd.slice(0, 80)}`;
  }
  return undefined;
}

export function runAgent(o: AgentOptions): Promise<AgentRun> {
  const args = [
    '-p', o.prompt,
    '--restricted',
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(curl:*)', 'Bash(node --check:*)',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', // aucun serveur MCP : moins d'outils exposés, contexte bien plus léger
    '--max-budget-usd', String(o.budgetUsd),
    '--output-format', 'stream-json', '--verbose',
    ...(o.model ? ['--model', o.model] : []),
  ];
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(o.logFile);
    const calls = new Map<string, ToolCall>();
    const order: ToolCall[] = [];
    let buffer = '';
    let lastText = '';
    let result: { subtype?: string; total_cost_usd?: number; num_turns?: number; result?: string } | undefined;
    const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs ?? 15 * 60_000);

    const onEvent = (e: any) => {
      if (e.type === 'assistant') {
        for (const c of e.message?.content ?? []) {
          if (c.type === 'text' && c.text.trim()) lastText = c.text;
          if (c.type === 'tool_use') {
            const call: ToolCall = { name: c.name, input: c.input ?? {}, denied: false };
            call.violation = audit(call, o.cwd, o.denyBash);
            calls.set(c.id, call);
            order.push(call);
          }
        }
      } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          const call = c.type === 'tool_result' ? calls.get(c.tool_use_id) : undefined;
          if (call && c.is_error) call.denied = true;
        }
      } else if (e.type === 'result') {
        result = e;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      log.write(chunk);
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) try { onEvent(JSON.parse(line)); } catch { /* ligne non JSON */ }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => log.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      resolvePromise({
        ok: code === 0 && result?.subtype === 'success',
        summary: (result?.result || lastText || '').trim(),
        costUsd: result?.total_cost_usd ?? 0,
        turns: result?.num_turns ?? 0,
        durationMs: Date.now() - started,
        toolCalls: order,
        stopReason: result?.subtype ?? `exit ${code}`,
      });
    });
  });
}
