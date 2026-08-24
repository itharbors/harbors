import type { AgentApprovalPolicy, AgentOptions, AgentSandboxMode, AgentTurnInput, AgentTurnOptions } from './adapter/base.js';

export const DEFAULT_SANDBOX_MODE: AgentSandboxMode = 'workspace-write';
export const DEFAULT_APPROVAL_POLICY: AgentApprovalPolicy = 'ask';

export interface PermissionDefaults {
  sandboxMode: AgentSandboxMode;
  approvalPolicy: AgentApprovalPolicy;
}

export function isSandboxMode(value: unknown): value is AgentSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

export function isApprovalPolicy(value: unknown): value is AgentApprovalPolicy {
  return value === 'ask' || value === 'always';
}

export function adapterPermissionDefaults(options: AgentOptions): PermissionDefaults {
  return {
    sandboxMode: isSandboxMode(options.permissions?.defaultSandboxMode)
      ? options.permissions.defaultSandboxMode
      : DEFAULT_SANDBOX_MODE,
    approvalPolicy: isApprovalPolicy(options.permissions?.defaultApprovalPolicy)
      ? options.permissions.defaultApprovalPolicy
      : DEFAULT_APPROVAL_POLICY,
  };
}

/** Read settings lazily; unavailable or invalid config values never break Agent calls. */
export function configuredPermissionDefaults(config: any, fallback: PermissionDefaults): PermissionDefaults {
  let sandboxMode: unknown;
  let approvalPolicy: unknown;
  try {
    sandboxMode = config?.get?.('agent.defaults.sandboxMode');
    approvalPolicy = config?.get?.('agent.defaults.approvalPolicy');
  } catch {
    return { ...fallback };
  }
  return {
    sandboxMode: isSandboxMode(sandboxMode) ? sandboxMode : fallback.sandboxMode,
    approvalPolicy: isApprovalPolicy(approvalPolicy) ? approvalPolicy : fallback.approvalPolicy,
  };
}

export function selectedOptions(
  options: AgentOptions,
  settings: AgentTurnOptions,
  permissions: PermissionDefaults = adapterPermissionDefaults(options),
): AgentTurnOptions {
  const model = settings.model || options.defaultModel;
  const modelOption = options.models.find((entry) => entry.id === model);
  const reasoningEffort = settings.reasoningEffort || modelOption?.defaultReasoningEffort || options.defaultReasoningEffort;
  const serviceTier = settings.serviceTier || modelOption?.defaultServiceTier || options.defaultServiceTier;
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    sandboxMode: settings.sandboxMode || permissions.sandboxMode,
    approvalPolicy: settings.approvalPolicy || permissions.approvalPolicy,
  };
}

export function withPermissionDefaults(input: AgentTurnInput, permissions: PermissionDefaults): AgentTurnOptions {
  const options: AgentTurnOptions = typeof input === 'string' ? (input ? { model: input } : {}) : input ? { ...input } : {};
  return {
    ...options,
    sandboxMode: options.sandboxMode || permissions.sandboxMode,
    approvalPolicy: options.approvalPolicy || permissions.approvalPolicy,
  };
}
