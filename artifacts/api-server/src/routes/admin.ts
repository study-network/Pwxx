import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { db, pool, accessKeysTable, notificationsTable, siteSettingsTable } from "@workspace/db";
import { eq, and, or, isNull, gt, desc } from "drizzle-orm";

const router = Router();
const AROLINKS_SOURCE = "arolinks";
const AROLINKS_LABEL = "Arolinks generated key";

// Simple admin auth middleware — checks X-Admin-Key header
const ADMIN_KEY = process.env.ADMIN_KEY || "admin-secret-2024";
const ACCESS_KEY_LENGTH = 18;

function hashAccessKey(key: string) {
  return createHash("sha256").update(key.trim().toUpperCase()).digest("hex");
}

function hashClaimToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createAccessKey() {
  const raw = randomBytes(ACCESS_KEY_LENGTH).toString("base64url").toUpperCase();
  return `PWX-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}`;
}

function createClaimToken() {
  return randomBytes(32).toString("base64url");
}

// ── In-Memory Fallback Stores (active when DATABASE_URL is not configured or query fails) ──
interface MemoryNotification {
  id: number;
  title: string;
  message: string;
  type: string;
  active: boolean;
  link: string | null;
  linkLabel: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

interface MemorySetting {
  key: string;
  value: any;
  updatedAt: Date;
}

interface MemoryAccessKey {
  id: number;
  keyHash: string;
  claimTokenHash: string | null;
  label: string | null;
  source: string;
  active: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  claimedAt: Date | null;
  lastUsedAt: Date | null;
}

interface MemoryAccessClaim {
  id: number;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
}

const memoryNotifications: MemoryNotification[] = [];
let memoryNotificationIdCounter = 1;

const memorySettings = new Map<string, MemorySetting>([
  ["maintenance", { key: "maintenance", value: { enabled: false }, updatedAt: new Date() }],
  ["access_gate", { key: "access_gate", value: { enabled: false }, updatedAt: new Date() }],
]);

const memoryAccessKeys: MemoryAccessKey[] = [];
let memoryKeyIdCounter = 1;

const memoryAccessClaims: MemoryAccessClaim[] = [];
let memoryClaimIdCounter = 1;

export async function cleanupExpiredArolinkKeys() {
  const now = new Date();
  for (let i = memoryAccessKeys.length - 1; i >= 0; i--) {
    const k = memoryAccessKeys[i];
    if (k.source === AROLINKS_SOURCE && k.expiresAt && k.expiresAt <= now) {
      memoryAccessKeys.splice(i, 1);
    }
  }

  if (process.env.DATABASE_URL) {
    try {
      const result = await pool.query(
        `DELETE FROM access_keys
         WHERE source = $1
           AND expires_at IS NOT NULL
           AND expires_at <= NOW()
         RETURNING id`,
        [AROLINKS_SOURCE],
      );
      return result.rowCount ?? 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

// ─── Arolinks handoff ─────────────────────────────────────────────
router.post("/access/prepare", async (_req, res) => {
  try {
    const token = createClaimToken();
    if (!process.env.DATABASE_URL) {
      memoryAccessClaims.push({
        id: memoryClaimIdCounter++,
        tokenHash: hashClaimToken(token),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        claimedAt: null,
      });
      res.json({ ok: true, token });
      return;
    }
    await pool.query(
      `INSERT INTO access_claims (token_hash, expires_at)
       VALUES ($1, NOW() + INTERVAL '15 minutes')`,
      [hashClaimToken(token)],
    );
    res.json({ ok: true, token });
  } catch (e) {
    const token = createClaimToken();
    memoryAccessClaims.push({
      id: memoryClaimIdCounter++,
      tokenHash: hashClaimToken(token),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      claimedAt: null,
    });
    res.json({ ok: true, token });
  }
});

router.post("/access/claim", async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    res.status(400).json({ ok: false, error: "Generation session required" });
    return;
  }

  if (!process.env.DATABASE_URL) {
    const tokenHash = hashClaimToken(token);
    const now = new Date();
    const claim = memoryAccessClaims.find(
      (c) => c.tokenHash === tokenHash && !c.claimedAt && c.expiresAt > now,
    );
    if (!claim) {
      res.status(410).json({ ok: false, error: "Generation session expired" });
      return;
    }
    claim.claimedAt = now;
    const plainKey = createAccessKey();
    const newKey: MemoryAccessKey = {
      id: memoryKeyIdCounter++,
      keyHash: hashAccessKey(plainKey),
      claimTokenHash: null,
      label: AROLINKS_LABEL,
      source: AROLINKS_SOURCE,
      active: true,
      createdAt: now,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      claimedAt: null,
      lastUsedAt: null,
    };
    memoryAccessKeys.push(newKey);
    res.json({ ok: true, key: plainKey, keyId: newKey.id });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT id
       FROM access_claims
       WHERE token_hash = $1
         AND claimed_at IS NULL
         AND expires_at > NOW()
       FOR UPDATE`,
      [hashClaimToken(token)],
    );

    if (pending.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(410).json({ ok: false, error: "Generation session expired" });
      return;
    }

    const plainKey = createAccessKey();
    const inserted = await client.query(
      `INSERT INTO access_keys (key_hash, label, source, active, expires_at)
       VALUES ($1, $2, $3, true, NOW() + INTERVAL '24 hours')
       RETURNING id`,
      [hashAccessKey(plainKey), AROLINKS_LABEL, AROLINKS_SOURCE],
    );
    await client.query(
      `UPDATE access_claims SET claimed_at = NOW() WHERE id = $1`,
      [pending.rows[0].id],
    );
    await client.query("COMMIT");
    res.json({ ok: true, key: plainKey, keyId: inserted.rows[0].id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ ok: false, error: "Unable to generate access key" });
  } finally {
    client.release();
  }
});

async function isAccessGateEnabled() {
  if (!db) {
    const setting = memorySettings.get("access_gate");
    return setting?.value && typeof setting.value === "object" && "enabled" in setting.value
      ? Boolean((setting.value as { enabled?: unknown }).enabled)
      : false;
  }
  try {
    const [setting] = await db
      .select()
      .from(siteSettingsTable)
      .where(eq(siteSettingsTable.key, "access_gate"));
    return setting?.value && typeof setting.value === "object" && "enabled" in setting.value
      ? Boolean((setting.value as { enabled?: unknown }).enabled)
      : false;
  } catch {
    return false;
  }
}

function adminAuth(req: any, res: any, next: any) {
  const authHeader = req.headers["authorization"] || "";
  const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const key = req.query._k || bearerKey || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Notifications ───────────────────────────────────────────────

// GET all notifications (public - active & non-expired only)
router.get("/notifications", async (_req, res) => {
  const now = new Date();
  if (!db) {
    const rows = memoryNotifications.filter(
      (n) => n.active && (!n.expiresAt || n.expiresAt > now),
    );
    res.json(rows);
    return;
  }
  try {
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.active, true),
          or(isNull(notificationsTable.expiresAt), gt(notificationsTable.expiresAt, now)),
        ),
      )
      .orderBy(notificationsTable.createdAt);
    res.json(rows);
  } catch (e) {
    const rows = memoryNotifications.filter(
      (n) => n.active && (!n.expiresAt || n.expiresAt > now),
    );
    res.json(rows);
  }
});

// GET all notifications (admin - all)
router.get("/admin/notifications", adminAuth, async (_req, res) => {
  if (!db) {
    res.json(memoryNotifications);
    return;
  }
  try {
    const rows = await db
      .select()
      .from(notificationsTable)
      .orderBy(notificationsTable.createdAt);
    res.json(rows);
  } catch (e) {
    res.json(memoryNotifications);
  }
});

// POST create notification
router.post("/admin/notifications", adminAuth, async (req, res) => {
  try {
    const { title, message, type = "info", link, linkLabel, expiresAt } = req.body;
    if (!title || !message) {
      res.status(400).json({ error: "title and message required" });
      return;
    }
    if (!db) {
      const row: MemoryNotification = {
        id: memoryNotificationIdCounter++,
        title,
        message,
        type,
        active: true,
        link: link || null,
        linkLabel: linkLabel || null,
        createdAt: new Date(),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      };
      memoryNotifications.push(row);
      res.json(row);
      return;
    }
    const [row] = await db
      .insert(notificationsTable)
      .values({
        title,
        message,
        type,
        link: link || null,
        linkLabel: linkLabel || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        active: true,
      })
      .returning();
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create notification" });
  }
});

// PATCH toggle notification active
router.patch("/admin/notifications/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { active } = req.body;
    if (!db) {
      const row = memoryNotifications.find((n) => n.id === id);
      if (!row) {
        res.status(404).json({ error: "Notification not found" });
        return;
      }
      row.active = Boolean(active);
      res.json(row);
      return;
    }
    const [row] = await db
      .update(notificationsTable)
      .set({ active })
      .where(eq(notificationsTable.id, id))
      .returning();
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// DELETE notification
router.delete("/admin/notifications/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db) {
      const idx = memoryNotifications.findIndex((n) => n.id === id);
      if (idx !== -1) memoryNotifications.splice(idx, 1);
      res.json({ success: true });
      return;
    }
    await db.delete(notificationsTable).where(eq(notificationsTable.id, id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// ─── Site Settings ───────────────────────────────────────────────

// GET a setting (public - used for maintenance check and access gate)
router.get("/settings/:key", async (req, res) => {
  const key = req.params.key;
  if (!db) {
    const row = memorySettings.get(key) ?? {
      key,
      value: { enabled: false },
      updatedAt: new Date(),
    };
    res.json(row);
    return;
  }
  try {
    const [row] = await db
      .select()
      .from(siteSettingsTable)
      .where(eq(siteSettingsTable.key, key));
    res.json(row ?? memorySettings.get(key) ?? { key, value: { enabled: false }, updatedAt: new Date() });
  } catch (e) {
    const row = memorySettings.get(key) ?? {
      key,
      value: { enabled: false },
      updatedAt: new Date(),
    };
    res.json(row);
  }
});

// Verify a generated access key. The key is intentionally never returned by
// any public endpoint; the client stores it only to re-check access on reload.
router.post("/access/verify", async (req, res) => {
  try {
    await cleanupExpiredArolinkKeys();

    if (!(await isAccessGateEnabled())) {
      res.json({ ok: true, bypass: true });
      return;
    }

    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    const claimToken = typeof req.body?.claimToken === "string" ? req.body.claimToken.trim() : "";
    if (!key) {
      res.status(400).json({ ok: false, error: "Access key required" });
      return;
    }

    if (!db) {
      const keyHash = hashAccessKey(key);
      const now = new Date();
      const row = memoryAccessKeys.find(
        (k) => k.keyHash === keyHash && k.active && (!k.expiresAt || k.expiresAt > now),
      );

      if (!row) {
        res.status(401).json({ ok: false, error: "Invalid or revoked access key" });
        return;
      }

      if (row.claimTokenHash) {
        if (!claimToken || hashClaimToken(claimToken) !== row.claimTokenHash) {
          res.status(409).json({
            ok: false,
            error: "This key is already assigned to another browser or device",
          });
          return;
        }
        row.lastUsedAt = new Date();
        res.json({ ok: true });
        return;
      }

      const newClaimToken = createClaimToken();
      row.claimTokenHash = hashClaimToken(newClaimToken);
      row.claimedAt = new Date();
      row.lastUsedAt = new Date();
      res.json({ ok: true, claimToken: newClaimToken });
      return;
    }

    const [row] = await db
      .select({ id: accessKeysTable.id })
      .from(accessKeysTable)
      .where(
        and(
          eq(accessKeysTable.keyHash, hashAccessKey(key)),
          eq(accessKeysTable.active, true),
          or(isNull(accessKeysTable.expiresAt), gt(accessKeysTable.expiresAt, new Date())),
        ),
      );

    if (!row) {
      res.status(401).json({ ok: false, error: "Invalid or revoked access key" });
      return;
    }

    const [fullRow] = await db
      .select({
        id: accessKeysTable.id,
        claimTokenHash: accessKeysTable.claimTokenHash,
      })
      .from(accessKeysTable)
      .where(and(eq(accessKeysTable.id, row.id), eq(accessKeysTable.active, true)));

    if (!fullRow) {
      res.status(401).json({ ok: false, error: "Invalid or revoked access key" });
      return;
    }

    if (fullRow.claimTokenHash) {
      if (!claimToken || hashClaimToken(claimToken) !== fullRow.claimTokenHash) {
        res.status(409).json({
          ok: false,
          error: "This key is already assigned to another browser or device",
        });
        return;
      }

      await db
        .update(accessKeysTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(accessKeysTable.id, fullRow.id));
      res.json({ ok: true });
      return;
    }

    const newClaimToken = createClaimToken();
    const [claimed] = await db
      .update(accessKeysTable)
      .set({
        claimTokenHash: hashClaimToken(newClaimToken),
        claimedAt: new Date(),
        lastUsedAt: new Date(),
      })
      .where(
        and(
          eq(accessKeysTable.id, fullRow.id),
          eq(accessKeysTable.active, true),
          isNull(accessKeysTable.claimTokenHash),
        ),
      )
      .returning({ id: accessKeysTable.id });

    if (!claimed) {
      res.status(409).json({
        ok: false,
        error: "This key was just assigned to another browser or device",
      });
      return;
    }

    res.json({ ok: true, claimToken: newClaimToken });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unable to verify access key" });
  }
});

// GET all settings (admin)
router.get("/admin/settings", adminAuth, async (_req, res) => {
  if (!db) {
    res.json(Array.from(memorySettings.values()));
    return;
  }
  try {
    const rows = await db.select().from(siteSettingsTable);
    res.json(rows);
  } catch (e) {
    res.json(Array.from(memorySettings.values()));
  }
});

// List key metadata only.
router.get("/admin/access-keys", adminAuth, async (_req, res) => {
  try {
    await cleanupExpiredArolinkKeys();
    if (!db) {
      res.json(
        memoryAccessKeys.map((k) => ({
          id: k.id,
          label: k.label,
          source: k.source,
          active: k.active,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt,
          claimedAt: k.claimedAt,
          lastUsedAt: k.lastUsedAt,
        })),
      );
      return;
    }
    const rows = await db
      .select({
        id: accessKeysTable.id,
        label: accessKeysTable.label,
        source: accessKeysTable.source,
        active: accessKeysTable.active,
        createdAt: accessKeysTable.createdAt,
        expiresAt: accessKeysTable.expiresAt,
        claimedAt: accessKeysTable.claimedAt,
        lastUsedAt: accessKeysTable.lastUsedAt,
      })
      .from(accessKeysTable)
      .orderBy(desc(accessKeysTable.createdAt));
    res.json(rows);
  } catch (e) {
    res.json(
      memoryAccessKeys.map((k) => ({
        id: k.id,
        label: k.label,
        source: k.source,
        active: k.active,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
        claimedAt: k.claimedAt,
        lastUsedAt: k.lastUsedAt,
      })),
    );
  }
});

router.post("/admin/access-keys", adminAuth, async (req, res) => {
  try {
    const plainKey = createAccessKey();
    const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 80) : null;
    if (!db) {
      const row: MemoryAccessKey = {
        id: memoryKeyIdCounter++,
        keyHash: hashAccessKey(plainKey),
        claimTokenHash: null,
        label: label || null,
        source: "admin",
        active: true,
        createdAt: new Date(),
        expiresAt: null,
        claimedAt: null,
        lastUsedAt: null,
      };
      memoryAccessKeys.push(row);
      res.json({ ...row, key: plainKey });
      return;
    }
    const [row] = await db
      .insert(accessKeysTable)
      .values({ keyHash: hashAccessKey(plainKey), label: label || null, active: true })
      .returning({
        id: accessKeysTable.id,
        label: accessKeysTable.label,
        source: accessKeysTable.source,
        active: accessKeysTable.active,
        createdAt: accessKeysTable.createdAt,
        expiresAt: accessKeysTable.expiresAt,
      });
    res.json({ ...row, key: plainKey });
  } catch (e) {
    res.status(500).json({ error: "Failed to generate access key" });
  }
});

router.patch("/admin/access-keys/:id", adminAuth, async (req, res) => {
  try {
    const active = Boolean(req.body?.active);
    const id = Number(req.params.id);
    if (!db) {
      const row = memoryAccessKeys.find((k) => k.id === id);
      if (!row) {
        res.status(404).json({ error: "Access key not found" });
        return;
      }
      row.active = active;
      res.json({ id: row.id, active: row.active });
      return;
    }
    const [row] = await db
      .update(accessKeysTable)
      .set({ active })
      .where(eq(accessKeysTable.id, id))
      .returning({ id: accessKeysTable.id, active: accessKeysTable.active });
    if (!row) {
      res.status(404).json({ error: "Access key not found" });
      return;
    }
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update access key" });
  }
});

router.delete("/admin/access-keys/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db) {
      const idx = memoryAccessKeys.findIndex((k) => k.id === id);
      if (idx === -1) {
        res.status(404).json({ error: "Access key not found" });
        return;
      }
      memoryAccessKeys.splice(idx, 1);
      res.json({ success: true });
      return;
    }
    const deleted = await db
      .delete(accessKeysTable)
      .where(eq(accessKeysTable.id, id))
      .returning({ id: accessKeysTable.id });
    if (!deleted.length) {
      res.status(404).json({ error: "Access key not found" });
      return;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to permanently delete access key" });
  }
});

// PUT upsert setting
router.put("/admin/settings/:key", adminAuth, async (req, res) => {
  try {
    const { value } = req.body;
    const key = req.params.key;
    const settingObj: MemorySetting = { key, value, updatedAt: new Date() };
    memorySettings.set(key, settingObj);

    if (!db) {
      res.json(settingObj);
      return;
    }
    const [row] = await db
      .insert(siteSettingsTable)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: siteSettingsTable.key,
        set: { value, updatedAt: new Date() },
      })
      .returning();
    res.json(row ?? settingObj);
  } catch (e) {
    const key = req.params.key;
    res.json(memorySettings.get(key));
  }
});

// ─── Admin Auth Check ─────────────────────────────────────────────

router.post("/admin/auth", (req, res) => {
  const { key } = req.body;
  if (key === ADMIN_KEY) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid admin key" });
  }
});

export default router;
