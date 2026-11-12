const sessions = new Map<string, { userId: string; expiresAt: number }>();

export function createSession(userId: string): string {
  const token = Math.random().toString(36).slice(2);
  sessions.set(token, { userId, expiresAt: Date.now() + 3_600_000 });
  return token;
}

export function verifySession(token: string): string | null {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  return session.userId;
}
