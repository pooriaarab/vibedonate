import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCascade, createConsentLedger, localRunners, pickLocalRunner, realDeps } from '@pooriaarab/vibe-core';
import type { Capability, LocalRunner, SystemDeps } from '@pooriaarab/vibe-core';

export const CHAT_CAPABILITY: Capability = 'chat';
export interface LabeledRunner extends LocalRunner { readonly id: string; }
export interface LocalComputeDeps {
  readonly system?: SystemDeps;
  readonly runners?: readonly LabeledRunner[];
  readonly pickLocal?: (capability: Capability) => Promise<LocalRunner | null>;
}
export interface ComputeResolution {
  readonly tier: import('@pooriaarab/vibe-core').CascadeTier;
  readonly egress: false;
  readonly available: boolean;
  readonly label: string;
  readonly runner?: LocalRunner;
}
const DEFAULT_OLLAMA_MODEL = process.env['VIBEDONATE_OLLAMA_MODEL'] && process.env['VIBEDONATE_OLLAMA_MODEL'].length > 0 ? process.env['VIBEDONATE_OLLAMA_MODEL'] : 'qwen2.5:7b';
export type ExecCapture = (bin: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
const realExec: ExecCapture = promisify(execFile);
export function createOllamaChatRunner(deps: SystemDeps = realDeps, model: string = DEFAULT_OLLAMA_MODEL, exec: ExecCapture = realExec): LabeledRunner {
  return {
    id: `ollama · ${model}`,
    capability: CHAT_CAPABILITY,
    async available() { return deps.detect('ollama'); },
    async generate<TReq = unknown, TOut = unknown>(req: TReq): Promise<TOut> {
      const r = req as { model?: string; prompt: string };
      const useModel = r.model ?? model;
      if (!useModel) throw new Error('ollama generate() needs a model');
      if (typeof r.prompt !== 'string') throw new Error('ollama generate() needs { prompt: string }');
      const { stdout } = await exec('ollama', ['run', useModel, r.prompt]);
      return { model: useModel, output: stdout } as TOut;
    },
  };
}
export function defaultChatRunners(deps: SystemDeps = realDeps): readonly LabeledRunner[] {
  return [createOllamaChatRunner(deps)];
}
export async function resolveCompute(deps: LocalComputeDeps = {}): Promise<ComputeResolution> {
  const runners = deps.runners ?? defaultChatRunners(deps.system);
  const pickLocal = deps.pickLocal ?? ((capability: Capability) => pickLocalRunner(capability, runners));
  const cascade = createCascade({ consent: createConsentLedger(), pickLocal });
  try {
    const resolved = await cascade.resolve({ capability: CHAT_CAPABILITY, allowEgress: false });
    const runner: LocalRunner | undefined = resolved.tier === 'local' ? (resolved.provider as LocalRunner) : undefined;
    const labeled = runner !== undefined ? runners.find((r) => r === runner) : undefined;
    return { tier: 'local', egress: false, available: true, label: labeled !== undefined ? labeled.id : resolved.label, runner };
  } catch {
    return { tier: 'local', egress: false, available: false, label: 'no local chat model (install ollama + `ollama pull <model>`)', };
  }
}
