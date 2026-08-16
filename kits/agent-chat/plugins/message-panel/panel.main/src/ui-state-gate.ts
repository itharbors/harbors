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
