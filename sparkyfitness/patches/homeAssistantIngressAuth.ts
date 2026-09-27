/*
 * Signs in whoever Home Assistant says is asking, when the request came in
 * through Ingress.
 *
 * Home Assistant has established who is behind an Ingress request long before
 * it gets here, and the Supervisor names them in headers no browser can set.
 * The app's NGINX copies the user's id and name into the X-Sparky-HA-* headers
 * read below, on the Ingress server only, and clears them everywhere else. The
 * server itself only listens on loopback, so nothing but that NGINX can reach
 * it to set them.
 *
 * Each Home Assistant user is matched to a SparkyFitness user of their own
 * through an account row, keyed on their Home Assistant user id. That id never
 * changes, so renaming somebody in Home Assistant keeps their data with them.
 * The user is created on their first visit, the same way SparkyFitness' own
 * sign-up would, which also means the very first one becomes the
 * administrator: a trigger in the database hands that role to whoever is
 * inserted first.
 *
 * Nothing is handed to the browser. The session this mints is signed and
 * placed on the request itself, where every part of SparkyFitness that checks
 * for one looks, exactly like the bearer token bridge SparkyFitness already
 * has for its mobile app. So there is no cookie of ours sitting on the Home
 * Assistant origin, and nothing that could leak out of it.
 */
import type { NextFunction, Request, Response } from 'express';
import { serializeSignedCookie } from 'better-call';
import { v4 as uuidv4 } from 'uuid';
import { auth } from '../auth.js';
import { log } from '../config/logging.js';
import { getSystemClient } from '../db/poolManager.js';
import { ensureUserInitialization } from '../models/userRepository.js';
import { createDefaultNutrientPreferencesForUser } from '../services/nutrientDisplayPreferenceService.js';

const PROVIDER_ID = 'homeassistant';
const EMAIL_DOMAIN = 'homeassistant.local';

// How long a session found valid is trusted before the database is asked
// again. Short enough that a session revoked from within SparkyFitness, or a
// user deleted by an administrator, is noticed within a minute.
const RECHECK_AFTER_MS = 60 * 1000;

interface IngressSession {
  userId: string;
  token: string;
  checkedAt: number;
}

const sessions = new Map<string, IngressSession>();

// The first page load fires a dozen requests at once. They all wait for the
// same lookup rather than racing each other into creating the user twice.
const inflight = new Map<string, Promise<IngressSession>>();

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The address SparkyFitness knows the user by. It has to be unique and look
 * like an email address, but nothing is ever sent to it. Named after the Home
 * Assistant username where that makes for a valid address, which is friendlier
 * to hand out to family members sharing their diary, and after the id when it
 * does not, which always does.
 */
function emailCandidates(haUserId: string, haUserName: string): string[] {
  const local = haUserName.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const candidates = [];
  if (/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(local)) {
    candidates.push(`${local}@${EMAIL_DOMAIN}`);
  }
  candidates.push(`${haUserId}@${EMAIL_DOMAIN}`);
  return candidates;
}

async function findOrCreateUser(
  haUserId: string,
  haUserName: string,
  haDisplayName: string
): Promise<string> {
  const client = await getSystemClient();
  let created = false;
  let userId: string;
  try {
    await client.query('BEGIN');
    // Another instance of this very lookup, in the same process or not, waits
    // here until the first has committed, and then finds its user.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${PROVIDER_ID}:${haUserId}`,
    ]);

    const existing = await client.query(
      'SELECT user_id FROM "account" WHERE provider_id = $1 AND account_id = $2 LIMIT 1',
      [PROVIDER_ID, haUserId]
    );

    if (existing.rows.length > 0) {
      userId = existing.rows[0].user_id;
    } else {
      userId = uuidv4();
      const name = haDisplayName || haUserName || 'Home Assistant user';

      let email: string | undefined;
      for (const candidate of emailCandidates(haUserId, haUserName)) {
        const taken = await client.query(
          'SELECT 1 FROM "user" WHERE lower(email) = lower($1)',
          [candidate]
        );
        if (taken.rows.length === 0) {
          email = candidate;
          break;
        }
      }
      if (!email) {
        throw new Error(
          `No free email address left for Home Assistant user ${haUserId}`
        );
      }

      await client.query(
        'INSERT INTO "user" (id, email, email_verified, name, created_at, updated_at) VALUES ($1, $2, true, $3, now(), now())',
        [userId, email, name]
      );
      // The account row is what ties this user to Home Assistant. It carries
      // no password, so this user cannot be signed in to with one: Ingress is
      // the only way in, and API keys are how the mobile app gets access.
      await client.query(
        'INSERT INTO "account" (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now(), now())',
        [haUserId, PROVIDER_ID, userId]
      );
      await ensureUserInitialization(userId, name, null, client);
      created = true;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (created) {
    log(
      'info',
      `[HA INGRESS] Created a SparkyFitness user for Home Assistant user '${haUserName || haUserId}'.`
    );
    // What SparkyFitness' own sign-up does after creating a user, outside the
    // transaction because it reads back through the regular pools.
    await createDefaultNutrientPreferencesForUser(userId);
  }

  return userId;
}

async function sessionIsValid(session: IngressSession): Promise<boolean> {
  const client = await getSystemClient();
  try {
    // A day of margin, so a session is never handed on that expires halfway
    // through somebody using it.
    const result = await client.query(
      'SELECT 1 FROM "session" WHERE token = $1 AND user_id = $2 AND expires_at > now() + interval \'1 day\'',
      [session.token, session.userId]
    );
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

async function resolveSession(
  haUserId: string,
  haUserName: string,
  haDisplayName: string
): Promise<IngressSession> {
  const cached = sessions.get(haUserId);
  if (cached) {
    if (Date.now() - cached.checkedAt < RECHECK_AFTER_MS) {
      return cached;
    }
    if (await sessionIsValid(cached)) {
      cached.checkedAt = Date.now();
      return cached;
    }
    sessions.delete(haUserId);
  }

  const userId = await findOrCreateUser(haUserId, haUserName, haDisplayName);
  // Created the way SparkyFitness creates every session, so its own hooks run:
  // the last login is recorded, and a banned user is refused one.
  const context = await auth.$context;
  const created = await context.internalAdapter.createSession(userId);
  if (!created) {
    throw new Error(`Could not create a session for user ${userId}`);
  }

  const session = { userId, token: created.token, checkedAt: Date.now() };
  sessions.set(haUserId, session);
  return session;
}

/**
 * Puts the session on the request as the signed cookie SparkyFitness expects,
 * replacing whatever session cookie the browser sent. Mirrors
 * utils/bearerAuthBridge.ts, which does the same for the mobile app.
 */
async function injectSessionCookie(req: Request, token: string) {
  const prefix = auth.options.advanced?.cookiePrefix || 'better-auth';
  const secure = auth.options.advanced?.useSecureCookies ? '__Secure-' : '';
  const cookieName = `${secure}${prefix}.session_token`;
  const signed = await serializeSignedCookie(
    cookieName,
    token,
    // @ts-expect-error auth.options.secret is typed as a string, but is a Buffer
    auth.options.secret
  );

  const nameOf = (part: string) => {
    const eq = part.indexOf('=');
    return eq === -1 ? part : part.slice(0, eq).trim();
  };
  const others = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && nameOf(part) !== cookieName);

  req.headers.cookie = [...others, signed.split(';')[0]].join('; ');
}

export async function homeAssistantIngressAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Restoring one of SparkyFitness' own backups replaces the database, and
  // with it every session there is. None of those remembered here survive it.
  if (req.path === '/api/admin/backup/restore') {
    res.on('finish', () => sessions.clear());
  }

  const haUserId = header(req, 'x-sparky-ha-user-id');
  const haUserName = header(req, 'x-sparky-ha-user-name');
  const haDisplayName = header(req, 'x-sparky-ha-user-display-name');
  delete req.headers['x-sparky-ha-user-id'];
  delete req.headers['x-sparky-ha-user-name'];
  delete req.headers['x-sparky-ha-user-display-name'];

  if (!haUserId) {
    return next();
  }

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(haUserId)) {
    log('warn', '[HA INGRESS] Ignoring a malformed Home Assistant user id.');
    return next();
  }

  // Credentials sent along explicitly, like an API key, are what the caller
  // asked to be treated as.
  if (req.headers.authorization || req.headers['x-api-key']) {
    return next();
  }

  try {
    let pending = inflight.get(haUserId);
    if (!pending) {
      pending = resolveSession(haUserId, haUserName, haDisplayName).finally(
        () => inflight.delete(haUserId)
      );
      inflight.set(haUserId, pending);
    }
    const session = await pending;
    await injectSessionCookie(req, session.token);

    // Signing out ends this session, and the next request gets a new one.
    // Forgetting it here, rather than a minute from now when it would be
    // rechecked, keeps that next request from carrying a session that is gone.
    if (req.path === '/api/auth/sign-out') {
      sessions.delete(haUserId);
    }

    return next();
  } catch (error) {
    log(
      'error',
      '[HA INGRESS] Signing in a Home Assistant user failed:',
      error
    );
    return next(error);
  }
}
