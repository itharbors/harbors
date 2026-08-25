export interface PublicUserSummary {
  userId: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicSessionSummary {
  sessionId: string;
  ownerUserId: string | null;
  createdAt: number;
  lastAccessAt: number;
}

export interface WorkbenchContext {
  actor: 'local-admin' | 'user';
  currentUser: PublicUserSummary | null;
  users: PublicUserSummary[];
  sessions: PublicSessionSummary[];
  ownerlessSessions: PublicSessionSummary[];
}
