export interface ConversationUiStateGate {
  latestSequence: number;
  latestGeneration: string | null;
  latestRevision: number | null;
  seenGenerations: Set<string>;
}

export interface ConversationUiStateGateInput {
  sequence: number;
  generation: string | null;
  revision: number | null;
}

export function createConversationUiStateGate(): ConversationUiStateGate {
  return {
    latestSequence: -1,
    latestGeneration: null,
    latestRevision: null,
    seenGenerations: new Set<string>(),
  };
}

export function acceptConversationUiState(
  gate: ConversationUiStateGate,
  input: ConversationUiStateGateInput,
): boolean {
  if (input.sequence < gate.latestSequence) return false;

  // getState 的初始化响应会复用 effect 启动时捕获的 sequence。若此时
  // Panel bridge 已先交付了广播，即使两者 generation 不同，也不能让这个
  // 同序的旧快照清空刚收到的草稿态；真正的新 generation 事件会通过 setter
  // 先递增 sequence 后再进入这里。
  if (input.sequence === gate.latestSequence && gate.latestRevision !== null) return false;

  const hasSeenGeneration = input.generation !== null && gate.seenGenerations.has(input.generation);
  if (hasSeenGeneration && input.generation !== gate.latestGeneration) return false;

  const isNewGeneration = input.generation !== null && !hasSeenGeneration;
  if (!isNewGeneration) {
    if (input.sequence === gate.latestSequence
      && (input.revision === null || gate.latestRevision === null || input.revision <= gate.latestRevision)) return false;
    if (input.revision !== null && gate.latestRevision !== null && input.revision < gate.latestRevision) return false;
  }

  gate.latestSequence = input.sequence;
  if (input.generation !== null) {
    gate.seenGenerations.add(input.generation);
    gate.latestGeneration = input.generation;
  }
  if (input.revision !== null) gate.latestRevision = input.revision;
  return true;
}
