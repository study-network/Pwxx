/**
 * Database-backed session store for Telegram verification.
 * Replaces the in-memory Map so sessions survive server restarts / cold starts.
 */
import { pool } from "@workspace/db";

const SESSION_TTL_MIN = 30; // minutes a session lives before bot interaction
const CODE_TTL_MIN    =  5; // minutes a code is valid after being issued

export interface TgSession {
  code: string | null;
  userId: number | null;
  userName: string | null;
  verified: boolean;
  createdAt: Date;
  codeIssuedAt: Date | null;
}

// In-memory fallback map when DATABASE_URL is not configured
const memSessions = new Map<string, TgSession & { expiresAt: Date }>();

export async function createSession(sessionId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000);
  if (!process.env.DATABASE_URL) {
    memSessions.set(sessionId, {
      code: null,
      userId: null,
      userName: null,
      verified: false,
      createdAt: new Date(),
      codeIssuedAt: null,
      expiresAt,
    });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO tg_sessions (session_id, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, expiresAt],
    );
  } catch {
    memSessions.set(sessionId, {
      code: null,
      userId: null,
      userName: null,
      verified: false,
      createdAt: new Date(),
      codeIssuedAt: null,
      expiresAt,
    });
  }
}

export async function getSession(sessionId: string): Promise<TgSession | undefined> {
  if (!process.env.DATABASE_URL) {
    const s = memSessions.get(sessionId);
    if (!s || s.expiresAt < new Date() || s.verified) return undefined;
    return s;
  }
  try {
    const res = await pool.query(
      `SELECT code, user_id, user_name, verified, created_at, code_issued_at
       FROM tg_sessions
       WHERE session_id = $1 AND expires_at > NOW() AND verified = false`,
      [sessionId],
    );
    if (res.rowCount === 0) return undefined;
    const row = res.rows[0];
    return {
      code: row.code ?? null,
      userId: row.user_id ? Number(row.user_id) : null,
      userName: row.user_name ?? null,
      verified: row.verified,
      createdAt: row.created_at,
      codeIssuedAt: row.code_issued_at ?? null,
    };
  } catch {
    const s = memSessions.get(sessionId);
    if (!s || s.expiresAt < new Date() || s.verified) return undefined;
    return s;
  }
}

export async function setCode(
  sessionId: string,
  code: string,
  userId: number,
  userName: string,
): Promise<boolean> {
  const codeExpiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000);
  if (!process.env.DATABASE_URL) {
    const s = memSessions.get(sessionId);
    if (!s || s.expiresAt < new Date()) return false;
    s.code = code;
    s.userId = userId;
    s.userName = userName;
    s.codeIssuedAt = new Date();
    s.expiresAt = codeExpiresAt;
    return true;
  }
  try {
    const res = await pool.query(
      `UPDATE tg_sessions
       SET code = $2, user_id = $3, user_name = $4, code_issued_at = NOW(),
           expires_at = $5
       WHERE session_id = $1 AND expires_at > NOW()`,
      [sessionId, code, userId, userName, codeExpiresAt],
    );
    return (res.rowCount ?? 0) > 0;
  } catch {
    const s = memSessions.get(sessionId);
    if (!s || s.expiresAt < new Date()) return false;
    s.code = code;
    s.userId = userId;
    s.userName = userName;
    s.codeIssuedAt = new Date();
    s.expiresAt = codeExpiresAt;
    return true;
  }
}

export async function verifyCode(
  sessionId: string,
  code: string,
): Promise<TgSession | null> {
  if (!process.env.DATABASE_URL) {
    const s = memSessions.get(sessionId);
    if (!s || s.expiresAt < new Date() || s.verified || s.code !== code.trim()) return null;
    memSessions.delete(sessionId);
    return { ...s, verified: true };
  }
  try {
    const res = await pool.query(
      `SELECT code, user_id, user_name, created_at, code_issued_at
       FROM tg_sessions
       WHERE session_id = $1
         AND expires_at > NOW()
         AND code = $2
         AND verified = false`,
      [sessionId, code.trim()],
    );
    if (res.rowCount === 0) return null;

    await pool.query(`DELETE FROM tg_sessions WHERE session_id = $1`, [sessionId]);

    const row = res.rows[0];
    return {
      code: row.code,
      userId: row.user_id ? Number(row.user_id) : null,
      userName: row.user_name ?? null,
      verified: true,
      createdAt: row.created_at,
      codeIssuedAt: row.code_issued_at ?? null,
    };
  } catch {
    const s = memSessions.get(sessionId);
    if (!s || s.expiresAt < new Date() || s.verified || s.code !== code.trim()) return null;
    memSessions.delete(sessionId);
    return { ...s, verified: true };
  }
}

export async function pruneExpiredSessions(): Promise<void> {
  const now = new Date();
  for (const [id, s] of memSessions.entries()) {
    if (s.expiresAt < now) memSessions.delete(id);
  }
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(`DELETE FROM tg_sessions WHERE expires_at < NOW()`);
    } catch {}
  }
}
