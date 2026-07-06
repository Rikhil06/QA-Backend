// ── Load .env before anything else ──────────────────────────────────────────
require('dotenv').config();

// ── Validate required environment variables ──────────────────────────────────
const REQUIRED_ENV = [
  // Core
  'JWT_SECRET',
  'DATABASE_URL',
  'APP_URL',
  // Stripe billing
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PRICE_STARTER_MONTHLY',
  'PRICE_STARTER_YEARLY',
  'PRICE_TEAM_MONTHLY',
  'PRICE_TEAM_YEARLY',
  // Cloudflare R2 storage
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY',
  'R2_SECRET_KEY',
  'R2_BUCKET_NAME',
  // Email
  'RESEND_API_KEY',
];

const OPTIONAL_ENV = [
  'ALLOWED_ORIGINS', // defaults to APP_URL
  'SENTRY_DSN',      // optional — error tracking only
  'PRICE_FREE_MONTHLY',
  'PRICE_FREE_YEARLY',
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[startup] FATAL — missing required environment variables:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const missingOptional = OPTIONAL_ENV.filter((k) => !process.env[k]);
if (missingOptional.length) {
  console.warn(`[startup] Optional env vars not set (non-fatal): ${missingOptional.join(', ')}`);
}

// ── Sentry must be initialised before everything else ──────────────────────
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  enabled: process.env.NODE_ENV === 'production' || !!process.env.SENTRY_DSN,
  integrations: [Sentry.prismaIntegration()],
  beforeSend(event) {
    // Strip Authorization headers from Sentry payloads
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
    return event;
  },
});

const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const axios = require('axios');
const { Resend } = require('resend');
const morgan = require('morgan');
// cheerio removed — was unused
const slugify = require('slugify');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { getUserTeams } = require('./services/userTeams.service');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const NodeCache = require('node-cache');
const helmet = require('helmet');
const compression = require('compression');

// ── Error logging helper ────────────────────────────────────────────────────
// Drop-in replacement for console.error that also forwards to Sentry.
// Accepts the same variadic args as console.error so every call site can be
// swapped with a find-and-replace without changing argument structure.
function captureError(...args) {
  console.error(...args);
  // Find the first real Error (or error-like object) in the arguments
  const err =
    args.find((a) => a instanceof Error) ||
    args.find((a) => a && typeof a === 'object' && a.message);
  const label = typeof args[0] === 'string' ? args[0] : undefined;
  if (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      extra: label ? { label } : undefined,
    });
  } else {
    // No Error object — capture as a message so it still surfaces in Sentry
    Sentry.captureMessage(args.map(String).join(' '), 'error');
  }
}

// Catch anything that slipped through unhandled
process.on('uncaughtException', (err) => {
  captureError('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  captureError(
    'unhandledRejection',
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

const {
  uploadBufferToR2,
  getSignedR2Url,
  refreshR2Url,
  generateThumbnail,
  deleteObjectFromR2,
  deleteObjectsFromR2,
  keyFromSignedUrl,
} = require('./cloudlare/cloudflare-r2');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // same-origin / mobile
      const allowed = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || 'http://localhost:3000')
        .split(',').map((o) => o.trim());
      if (allowed.includes(origin)) return callback(null, true);
      return callback(new Error(`Socket CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  },
});
const prisma = new PrismaClient();
const PORT = process.env.PORT || 4000;
const ENV = process.env.NODE_ENV || 'development';

// In-memory revoked token set. Tokens are added on logout and checked in
// authenticateToken. Resets on process restart, but combined with the 7d
// expiry and httpOnly cookie clearing this covers the primary threat model.
// Replace with Redis for multi-instance deployments.
const revokedJtis = new Set();

async function getStripeAccountEmail() {
  const account = await stripe.accounts.retrieve();
  return account.email;
}

function mapPriceToPlan(priceId) {
  switch (priceId) {
    case process.env.PRICE_STARTER_MONTHLY:
    case process.env.PRICE_STARTER_YEARLY:
      return 'starter';

    case process.env.PRICE_TEAM_MONTHLY:
    case process.env.PRICE_TEAM_YEARLY:
      return 'team';

    case process.env.PRICE_FREE_MONTHLY:
    case process.env.PRICE_FREE_YEARLY:
      return 'free';

    default:
      return 'agency';
  }
}

app.get('/stripe/account', authenticateToken, async (req, res) => {
  try {
    const email = await getStripeAccountEmail();
    res.json({ email });
  } catch (err) {
    captureError('stripe/account error:', err);
    res.status(500).json({ error: 'Failed to fetch billing account' });
  }
});

app.post(
  '/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const obj = event.data.object;

    // teamId is on checkout session metadata — NOT on subscription/invoice objects.
    // For subscription lifecycle events, look up the team via Stripe customer ID.
    const metaTeamId = obj?.metadata?.teamId;
    const stripeCustomerId = obj?.customer ?? obj?.data?.object?.customer;

    let teamId = metaTeamId;
    if (!teamId && stripeCustomerId) {
      const team = await prisma.team.findFirst({
        where: { stripeCustomerId },
        select: { id: true },
      });
      teamId = team?.id ?? null;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        if (!obj.subscription) break;

        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        const checkoutPlan = mapPriceToPlan(sub.items.data[0].price.id);
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

        await prisma.$transaction([
          prisma.subscription.upsert({
            where: { teamId },
            update: {
              plan: checkoutPlan,
              interval: sub.items.data[0].price.recurring.interval,
              status: sub.status,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
              stripePriceId: sub.items.data[0].price.id,
              currentPeriodEnd: periodEnd,
              teamId,
            },
            create: {
              teamId,
              plan: checkoutPlan,
              interval: sub.items.data[0].price.recurring.interval,
              status: sub.status,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
              stripePriceId: sub.items.data[0].price.id,
              currentPeriodEnd: periodEnd,
            },
          }),
          prisma.team.update({ where: { id: teamId }, data: { plan: checkoutPlan } }),
        ]);

        // Send plan activation email to all team members
        sendPlanEmail(teamId, checkoutPlan, 'activated').catch((err) =>
          captureError('Failed to send plan activation email:', err)
        );

        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        if (!teamId) break;
        const subPlan = mapPriceToPlan(obj.items.data[0].price.id);
        const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000) : null;

        // Fetch previous plan before updating so we can detect actual upgrades/downgrades
        const existingTeam = await prisma.team.findUnique({ where: { id: teamId }, select: { plan: true } });
        const previousPlan = existingTeam?.plan;

        await prisma.$transaction([
          prisma.subscription.upsert({
            where: { teamId },
            update: {
              plan: subPlan,
              interval: obj.items.data[0].price.recurring.interval,
              status: obj.status,
              stripePriceId: obj.items.data[0].price.id,
              currentPeriodEnd: periodEnd,
              teamId,
            },
            create: {
              teamId,
              plan: subPlan,
              interval: obj.items.data[0].price.recurring.interval,
              status: obj.status,
              stripeSubscriptionId: obj.id,
              stripePriceId: obj.items.data[0].price.id,
              currentPeriodEnd: periodEnd,
            },
          }),
          prisma.team.update({ where: { id: teamId }, data: { plan: subPlan } }),
        ]);

        // Only email on genuine plan changes (not renewal updates)
        if (previousPlan && previousPlan !== subPlan) {
          const direction = getPlanTier(subPlan) > getPlanTier(previousPlan) ? 'upgraded' : 'downgraded';
          sendPlanEmail(teamId, subPlan, direction).catch((err) =>
            captureError('Failed to send plan change email:', err)
          );
        }

        break;
      }

      case 'customer.subscription.deleted': {
        if (!teamId) break;
        await prisma.$transaction([
          prisma.subscription.update({
            where: { teamId },
            data: { status: 'canceled', plan: 'free' },
          }),
          prisma.team.update({ where: { id: teamId }, data: { plan: 'free' } }),
        ]);

        sendPlanEmail(teamId, 'free', 'canceled').catch((err) =>
          captureError('Failed to send cancellation email:', err)
        );

        break;
      }
    }

    res.json({ received: true });
  },
);

// Sentry v8+ auto-instruments Express — no request handler middleware needed.

// Trust the first proxy (Render, Vercel, etc.) so rate limiters see real IPs
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow images from R2
  contentSecurityPolicy: false, // handled by the frontend
}));

// Gzip all responses
app.use(compression());

// HTTP request logging — skip health checks to avoid noise
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
  skip: (req) => req.path === '/health',
}));

// Strict CORS — only allow known frontend origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim());

// The QA extension is injected into arbitrary third-party customer sites (the page whose
// bugs are being reported), so its origin can never be known ahead of time. Its requests are
// bearer-token authenticated (not cookie-based), so reflecting any origin here doesn't expose
// the dashboard to CSRF — a malicious page can't read the extension's stored token. The
// dashboard app itself still goes through the strict allowlist below.
const EXTENSION_ROUTES = ['/api/report'];

function corsForRequest(req, res, next) {
  if (EXTENSION_ROUTES.includes(req.path)) {
    return cors({ origin: true, credentials: false })(req, res, next);
  }
  return cors({
    origin: function (origin, callback) {
      // Allow no-origin requests (mobile apps, curl)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      // The browser sets the Origin header itself so a web page cannot spoof a
      // chrome-extension:// origin. In production we pin to the published extension ID
      // via CHROME_EXTENSION_ID; in dev we allow any extension origin for ease of testing.
      const allowedExtId = process.env.CHROME_EXTENSION_ID;
      if (allowedExtId) {
        if (origin === `chrome-extension://${allowedExtId}`) return callback(null, true);
      } else if (origin.startsWith('chrome-extension://')) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })(req, res, next);
}

app.use(corsForRequest);

// Ensure preflight works for all routes
app.options('*', corsForRequest);
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Health check — used by Render, uptime monitors, load balancers
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable', ts: new Date().toISOString() });
  }
});

// ── Rate Limiters ───────────────────────────────────────────────────────────

// Strict limiter for public auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in 15 minutes' },
});

// Per-user upload limiter (placed after authenticateToken so req.user is set)
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  message: { error: 'Upload limit reached, please try again later' },
});

// Search limiter — short window to prevent scraping
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests, please slow down' },
});

// Per-user resend-verification limiter — placed after authenticateToken so req.user is available.
// 3 emails per hour per user prevents inbox-spam without blocking legitimate use.
const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  message: { error: 'Too many verification emails sent. Please wait before requesting another.' },
});

// General API guard — broad safety net for all /api/* routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: (req) => req.path === '/billing/webhook', // never rate-limit Stripe webhooks
});

app.use('/api', apiLimiter);

// ── In-memory Cache ─────────────────────────────────────────────────────────

const appCache = new NodeCache({ checkperiod: 60, useClones: false });

const TTL = {
  STATS:   5 * 60,   // 5 minutes  — dashboard counters
  SITES:   2 * 60,   // 2 minutes  — sites list
  COLUMNS: 10 * 60,  // 10 minutes — kanban column config
  SEARCH:  30,       // 30 seconds — search results
};

// Cache middleware factory — wraps res.json to store + serve cached responses
function cacheMiddleware(keyFn, ttl) {
  return (req, res, next) => {
    const key = keyFn(req);
    const cached = appCache.get(key);
    if (cached !== undefined) {
      return res.json(cached);
    }
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode < 400) appCache.set(key, data, ttl);
      return originalJson(data);
    };
    next();
  };
}

// Invalidation helpers — called after any mutation that changes these datasets
function invalidateUserStats(userId) {
  ['open', 'inprogress', 'resolved', 'summary', 'weekly', 'avgresolution'].forEach(
    (k) => appCache.del(`stats:${k}:${userId}`)
  );
}
function invalidateUserSites(userId) {
  appCache.del(`sites:${userId}`);
}
function invalidateSiteColumns(slug) {
  appCache.del(`columns:${slug}`);
}

/**
 * Find a site the user is allowed to read.
 * Works for both team members (ownership via teamId) and board guests (BoardAccess).
 * The `slugOrDomain` param can be the DB slug field OR the domain field — we try both.
 */
async function resolveSiteForUser(slugOrDomain, teamId, userId) {
  // 1. Team-owner path: match by (slug OR domain) + teamId, but only if the
  // requester is actually a member of that team — otherwise a client could
  // pass an arbitrary teamId belonging to a site they have no access to.
  if (teamId && teamId !== 'null' && teamId !== 'undefined') {
    const membership = await prisma.teamMember.findFirst({ where: { teamId, userId } });
    if (membership) {
      const site = await prisma.site.findFirst({
        where: { OR: [{ slug: slugOrDomain, teamId }, { domain: slugOrDomain, teamId }] },
      });
      if (site) return site;
    }
  }

  // 2. Guest path: find the site by slug or domain, then verify BoardAccess
  const site = await prisma.site.findFirst({
    where: { OR: [{ slug: slugOrDomain }, { domain: slugOrDomain }] },
  });
  if (!site) return null;

  const access = await prisma.boardAccess.findUnique({
    where: { siteId_userId: { siteId: site.id, userId } },
  });
  return access ? site : null;
}

const fileFilter = (req, file, cb) => {
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'video/webm'];

  if (!allowed.includes(file.mimetype)) {
    return cb(
      new Error('Invalid file type. Only images, PDFs, and WebM videos are allowed.'),
      false,
    );
  }

  cb(null, true);
};

const uploadAttachments = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

function getUserTeamIds(req) {
  return req.user?.teams?.map((t) => t.teamId) || [];
}

// Returns site domains scoped to a specific team (verifying membership) or all accessible sites.
// Returns the report if the user owns it or is a member of its site's team. Throws 403 otherwise.
async function assertReportAccess(reportId, userId, res) {
  const report = await prisma.qAReport.findUnique({
    where: { id: reportId },
    include: { Site: { select: { teamId: true } } },
  });
  if (!report) { res.status(404).json({ error: 'Report not found' }); return null; }
  const siteTeamId = report.Site?.teamId;
  if (siteTeamId) {
    const member = await prisma.teamMember.findFirst({ where: { teamId: siteTeamId, userId } });
    if (member) return report;
  }
  if (report.userId === userId) return report;
  res.status(403).json({ error: 'Access denied' });
  return null;
}

async function getTeamSiteDomains(userId, teamId) {
  if (teamId) {
    const membership = await prisma.teamMember.findFirst({ where: { teamId, userId } });
    if (!membership) return [];
    const sites = await prisma.site.findMany({ where: { teamId }, select: { domain: true } });
    return sites.map((s) => s.domain);
  }
  const [owned, shared] = await Promise.all([
    prisma.site.findMany({
      where: { OR: [{ users: { some: { id: userId } } }, { team: { members: { some: { userId } } } }] },
      select: { domain: true },
    }),
    prisma.boardAccess.findMany({ where: { userId }, include: { site: { select: { domain: true } } } }),
  ]);
  return [...new Set([...owned.map((s) => s.domain), ...shared.map((a) => a.site.domain)])];
}

// Single source of truth for plan limits — mirrors the pricing page
const PLAN_LIMITS = {
  free:    { reports: 100,      members: 5,        sites: 3 },
  starter: { reports: 300,      members: 10,       sites: 5 },
  team:    { reports: Infinity, members: Infinity,  sites: Infinity },
  agency:  { reports: Infinity, members: Infinity,  sites: Infinity },
};

const bcrypt = require('bcryptjs');

const { formatDistanceToNow } = require('date-fns');

app.get('/api/activities', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;
  try {
    const siteDomains = await getTeamSiteDomains(userId, teamId);
    const activitiesDb = await prisma.activity.findMany({
      where: {
        report: {
          site: { in: siteDomains },
        },
      },
      include: {
        actor: true,
        report: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const activities = activitiesDb.map((a, index) => {
      const avatar = `${a.actor.name
        .split(' ')
        .map((n) => n[0])
        .join('')}`;

      // generate a random gradient for color or define a map per user
      const color = `from-cyan-500 to-blue-500`; // or dynamically assign

      let action = '';
      let priority = undefined;
      let status = undefined;
      let dueDate = undefined;

      switch (a.type) {
        case 'comment':
          action = a.message.includes('mentioned')
            ? 'mentioned you in'
            : 'commented on';
          break;
        case 'status':
          action = 'moved';
          status = a.status;
          break;
        case 'priority':
          action = 'updated';
          priority = a.priority;
          break;
        case 'due_date':
          action = 'updated';
          dueDate = a.dueDate;
          break;
        case 'assignment':
          action = 'assigned you to';
          break;
        case 'completed':
          action = 'completed';
          break;
        case 'created':
          action = 'created';
          break;
        default:
          action = a.type;
      }

      return {
        id: index + 1,
        type: a.type,
        user: {
          name: a.actor.name,
          avatar,
          color,
        },
        action,
        target: a.report?.comment || a.message,
        status,
        time: formatDistanceToNow(new Date(a.createdAt), { addSuffix: true }),
        icon: getIconByType(a.type), // see helper below
        iconColor: getIconColorByType(a.type),
        priority,
        dueDate,
        link: a.report
          ? `/reports/${a.report.siteName.toLowerCase()}?report=${a.report.id}`
          : '',
      };
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(activities);
  } catch (err) {
    captureError(err);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const requestingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    const prefs = requestingUser?.notificationPrefs;
    const wantsOverdue = !prefs || prefs.taskOverdue !== false;
    const wantsDueToday = !prefs || prefs.dueToday !== false;

    /* ----------------------------------
     * 1. Stored notifications
     * ---------------------------------- */
    const notifications = await prisma.notification.findMany({
      where: { userId },
      include: {
        site: true,
        report: true,
        comment: {
          include: { report: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    /* ----------------------------------
     * 2. Overdue tasks
     * ---------------------------------- */

    const overdueTasks = wantsOverdue
      ? await prisma.qAReport.findMany({
          where: {
            userId,
            dueDate: { lt: startOfDay },
            status: { notIn: ['done', 'resolved'] },
          },
          select: {
            id: true,
            title: true,
            dueDate: true,
            siteName: true,
          },
          take: 50,
        })
      : [];

    const overdueNotifications = overdueTasks.map((task) => ({
      id: `overdue-${task.id}`,
      type: 'TASK_OVERDUE',
      message: `Task "${task.title}" is overdue`,
      createdAt: task.dueDate,
      report: task,
      link: `/reports/${task.siteName?.toLowerCase()}?report=${task.id}`,
      read: false,
    }));

    /* ----------------------------------
     * 3. Tasks due today
     * ---------------------------------- */

    const dueTodayTasks = wantsDueToday
      ? await prisma.qAReport.findMany({
          where: {
            userId,
            dueDate: {
              gte: startOfDay,
              lte: endOfDay,
            },
            status: { notIn: ['done', 'resolved'] },
          },
          select: {
            id: true,
            title: true,
            dueDate: true,
            siteName: true,
          },
          take: 50,
        })
      : [];

    const dueTodayNotifications = dueTodayTasks.map((task) => ({
      id: `today-${task.id}`,
      type: 'TASK_DUE_TODAY',
      message: `Task "${task.title}" is due today`,
      createdAt: task.dueDate,
      report: task,
      link: `/reports/${task.siteName?.toLowerCase()}?report=${task.id}`,
      read: false,
    }));

    /* ----------------------------------
     * 4. Merge & sort
     * ---------------------------------- */
    const merged = [
      ...notifications.map((n) => ({
        id: n.id,
        type: n.type,
        message: n.message,
        read: n.read,
        createdAt: n.createdAt,
        site: n.site,
        report: n.report ?? n.comment?.report,
        link: n.report
          ? `/reports/${n.report.siteName?.toLowerCase()}?report=${n.report.id}`
          : null,
      })),
      ...overdueNotifications,
      ...dueTodayNotifications,
    ].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    res.json({
      count: merged.length,
      notifications: merged,
    });
  } catch (err) {
    captureError(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// helper functions
function getIconByType(type) {
  switch (type) {
    case 'comment':
      return 'MessageSquare'; // replace with actual imported icon if using React
    case 'status':
      return 'GitCommit';
    case 'assignment':
      return 'UserPlus';
    case 'completed':
      return 'CheckCircle2';
    case 'created':
      return 'AlertCircle';
    default:
      return 'ActivityIcon';
  }
}

function getIconColorByType(type) {
  switch (type) {
    case 'comment':
      return 'text-blue-400';
    case 'status':
      return 'text-purple-400';
    case 'assignment':
      return 'text-green-400';
    case 'completed':
      return 'text-green-400';
    case 'created':
      return 'text-orange-400';
    default:
      return 'text-gray-400';
  }
}

function stripTLD(url) {
  try {
    // Ensure the URL has a protocol
    const formattedUrl =
      url.startsWith('http://') || url.startsWith('https://')
        ? url
        : `https://${url}`;

    const hostname = new URL(formattedUrl).hostname.toLowerCase();

    // Remove 'www.' prefix
    const cleanHost = hostname.startsWith('www.')
      ? hostname.slice(4)
      : hostname;

    // Split into parts
    const parts = cleanHost.split('.');

    if (parts.length <= 1) return cleanHost; // nothing to strip

    // Remove the last part (TLD)
    parts.pop();

    // Handle common second-level TLDs like 'co.uk', 'org.uk'
    const secondLevelTLDs = ['co', 'org', 'net', 'gov', 'ac', 'edu'];
    if (parts.length > 1 && secondLevelTLDs.includes(parts[parts.length - 1])) {
      parts.pop();
    }

    return parts.join('.');
  } catch (e) {
    captureError('Invalid URL:', url);
    return url;
  }
}

// utils/activity.js (or in your app.js)
async function logActivity({
  userId,
  actorId,
  type,
  reportId,
  message,
  status,
  priority,
  dueDate,
}) {
  try {
    await prisma.activity.create({
      data: {
        userId, // The user who should see this activity
        actorId, // The user performing the action
        type, // 'comment', 'status', 'assignment', 'completed', 'created'
        reportId, // optional: link to a task/report
        message, // descriptive text
        status, // optional: e.g., 'to QA' for status changes
        priority,
        dueDate,
      },
    });
  } catch (err) {
    captureError('Failed to log activity:', err);
  }
}

module.exports = logActivity;

// ── Shared email template ───────────────────────────────────────────────────
function emailTemplate({ badgeText, heading, headingHighlight, body, ctaUrl, ctaLabel, footerNote }) {
  const highlight = headingHighlight
    ? heading.replace(
        headingHighlight,
        `<span style="background:linear-gradient(135deg,#a78bfa,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${headingHighlight}</span>`
      )
    : heading;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

        <!-- Logo header -->
        <tr><td style="padding-bottom:28px;" align="center">
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:linear-gradient(135deg,#7c3aed,#3b82f6);border-radius:10px;width:36px;height:36px;text-align:center;vertical-align:middle;" align="center">
                <svg viewBox="0 0 24 24" width="20" height="20" style="display:block;margin:8px auto;">
                  <path d="M12 20h9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </td>
              <td style="padding-left:10px;font-size:16px;font-weight:600;color:#ffffff;letter-spacing:-0.3px;">Annoture</td>
            </tr>
          </table>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#141414;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px 32px;">

          <!-- Badge -->
          ${badgeText ? `<div style="display:inline-block;padding:5px 12px;border-radius:999px;background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.25);color:#a78bfa;font-size:11px;font-weight:500;letter-spacing:0.3px;margin-bottom:20px;">${badgeText}</div>` : ''}

          <!-- Heading -->
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;letter-spacing:-0.4px;">${highlight}</h1>

          <!-- Body -->
          <div style="color:rgba(255,255,255,0.55);font-size:14px;line-height:1.7;margin-bottom:28px;">${body}</div>

          <!-- CTA -->
          ${ctaUrl ? `
          <table cellpadding="0" cellspacing="0">
            <tr><td style="border-radius:10px;background:linear-gradient(135deg,#7c3aed,#6d28d9);">
              <a href="${ctaUrl}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px;letter-spacing:-0.1px;">${ctaLabel || 'Open Annoture'} &rarr;</a>
            </td></tr>
          </table>` : ''}

          <!-- Divider -->
          <div style="border-top:1px solid rgba(255,255,255,0.06);margin:28px 0;"></div>

          <!-- Footer note -->
          <p style="margin:0;color:rgba(255,255,255,0.25);font-size:12px;line-height:1.6;">${footerNote || 'Questions? Email us at <a href="mailto:hello@annoture.com" style="color:rgba(167,139,250,0.7);text-decoration:none;">hello@annoture.com</a>'}</p>

        </td></tr>

        <!-- Bottom footer -->
        <tr><td style="padding-top:24px;text-align:center;">
          <p style="margin:0;color:rgba(255,255,255,0.18);font-size:11px;">
            &copy; ${new Date().getFullYear()} Annoture &middot;
            <a href="https://annoture.com/privacy-policy" style="color:rgba(255,255,255,0.25);text-decoration:none;">Privacy Policy</a> &middot;
            <a href="https://annoture.com/terms" style="color:rgba(255,255,255,0.25);text-decoration:none;">Terms</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Email verification helper ───────────────────────────────────────────────
async function sendVerificationEmail(email, name) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.verificationToken.upsert({
    where: { token },
    update: { expires },
    create: { identifier: `verify:${email}`, token, expires },
  });

  const verifyUrl = `${process.env.APP_URL}/verify-email?token=${token}`;
  const displayName = name || email;

  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'Annoture <onboarding@resend.dev>',
    to: email,
    subject: 'Verify your email address',
    html: emailTemplate({
      badgeText: 'Action required',
      heading: `Verify your email, ${displayName}`,
      headingHighlight: displayName,
      body: `Click the button below to verify your email address and activate your Annoture account. This link expires in <strong style="color:rgba(255,255,255,0.7);">24 hours</strong>.`,
      ctaUrl: verifyUrl,
      ctaLabel: 'Verify email',
      footerNote: `If you didn't create an Annoture account you can safely ignore this email. Or copy this link: <a href="${verifyUrl}" style="color:rgba(167,139,250,0.7);text-decoration:none;word-break:break-all;">${verifyUrl}</a>`,
    }),
  });
}

const PLAN_TIER = { free: 0, starter: 1, team: 2, agency: 3 };
function getPlanTier(plan) { return PLAN_TIER[plan] ?? 0; }

const PLAN_LABELS = { free: 'Free', starter: 'Starter', team: 'Team', agency: 'Agency' };

async function sendPlanEmail(teamId, plan, action) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { members: { include: { user: { select: { email: true, name: true } } } } },
  });
  if (!team) return;

  const appUrl = process.env.APP_URL || 'https://app.annoture.com';
  const planLabel = PLAN_LABELS[plan] || plan;

  const configs = {
    activated: (name) => ({
      badgeText: `${planLabel} plan`,
      heading: `You're on the ${planLabel} plan`,
      headingHighlight: planLabel,
      body: `Hi <strong style="color:rgba(255,255,255,0.8);">${name}</strong>, your ${planLabel} subscription is now active. Head to your dashboard to start capturing bug reports.`,
      ctaUrl: appUrl,
      ctaLabel: 'Go to dashboard',
      subject: `You're on the ${planLabel} plan`,
    }),
    upgraded: (name) => ({
      badgeText: 'Plan upgraded',
      heading: `Upgraded to ${planLabel}`,
      headingHighlight: planLabel,
      body: `Hi <strong style="color:rgba(255,255,255,0.8);">${name}</strong>, your plan has been upgraded to <strong style="color:rgba(255,255,255,0.8);">${planLabel}</strong>. Your new limits and features are available immediately.`,
      ctaUrl: appUrl,
      ctaLabel: 'Go to dashboard',
      subject: `Your plan has been upgraded to ${planLabel}`,
    }),
    downgraded: (name) => ({
      badgeText: 'Plan changed',
      heading: `Your plan is now ${planLabel}`,
      headingHighlight: planLabel,
      body: `Hi <strong style="color:rgba(255,255,255,0.8);">${name}</strong>, your Annoture plan has been updated to <strong style="color:rgba(255,255,255,0.8);">${planLabel}</strong>. Visit billing settings if you have questions about your new limits.`,
      ctaUrl: `${appUrl}/usage-billing`,
      ctaLabel: 'View billing',
      subject: `Your plan has changed to ${planLabel}`,
    }),
    canceled: (name) => ({
      badgeText: 'Subscription ended',
      heading: 'Your subscription has been cancelled',
      headingHighlight: null,
      body: `Hi <strong style="color:rgba(255,255,255,0.8);">${name}</strong>, your Annoture subscription has ended and your account has moved to the Free plan. Your data is safe — you can resubscribe at any time.`,
      ctaUrl: `${appUrl}/usage-billing`,
      ctaLabel: 'Resubscribe',
      subject: 'Your Annoture subscription has been cancelled',
    }),
  };

  await Promise.all(
    team.members.map(({ user }) => {
      const displayName = user.name || user.email;
      const config = configs[action] ? configs[action](displayName) : {
        badgeText: 'Plan update',
        heading: `Your plan has changed to ${planLabel}`,
        headingHighlight: planLabel,
        body: `Hi <strong style="color:rgba(255,255,255,0.8);">${displayName}</strong>, your Annoture plan has been updated to ${planLabel}.`,
        ctaUrl: appUrl,
        ctaLabel: 'Go to dashboard',
        subject: `Your Annoture plan has changed`,
      };

      return resend.emails.send({
        from: process.env.EMAIL_FROM || 'Annoture <onboarding@resend.dev>',
        to: user.email,
        subject: config.subject,
        html: emailTemplate(config),
      });
    })
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_RULES = [
  { test: (p) => p.length >= 8,           msg: 'Password must be at least 8 characters.' },
  { test: (p) => /[A-Z]/.test(p),         msg: 'Password must contain at least one uppercase letter.' },
  { test: (p) => /[a-z]/.test(p),         msg: 'Password must contain at least one lowercase letter.' },
  { test: (p) => /[0-9]/.test(p),         msg: 'Password must contain at least one number.' },
  { test: (p) => /[^A-Za-z0-9]/.test(p), msg: 'Password must contain at least one special character.' },
];

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email: rawEmail, password, name, team } = req.body;

  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const email = rawEmail.trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 128 characters or fewer.' });
  }

  const failedRule = PASSWORD_RULES.find((r) => !r.test(password));
  if (failedRule) {
    return res.status(400).json({ error: failedRule.msg });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { email, name, password: hashedPassword },
      include: { sites: true },
    });

    const token = jwt.sign(
      { jti: crypto.randomUUID(), name: user.name, id: user.id, email: user.email, teams: [] },
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
    );

    // Send verification email non-blocking — don't fail registration if email fails
    sendVerificationEmail(email, name).catch((err) =>
      captureError('Failed to send verification email:', err)
    );

    // Redeem any pending board invites for this email address
    const pendingInvites = await prisma.boardInvite.findMany({
      where: { email, used: false, expiresAt: { gt: new Date() } },
    });
    if (pendingInvites.length > 0) {
      await Promise.all(
        pendingInvites.map((invite) =>
          prisma.boardAccess.upsert({
            where: { siteId_userId: { siteId: invite.siteId, userId: user.id } },
            update: { role: invite.role },
            create: {
              siteId: invite.siteId,
              userId: user.id,
              role: invite.role,
              invitedById: invite.invitedById,
            },
          })
        )
      );
      await prisma.boardInvite.updateMany({
        where: { email, used: false },
        data: { used: true },
      });
    }

    setAuthCookie(res, token);
    // token is also returned in the body for the Chrome extension, which reads it from
    // the JSON response and stores it in chrome.storage.session (isolated, cleared on
    // browser close). The web app ignores data.token and relies on the httpOnly cookie.
    res.status(201).json({
      message: 'User registered',
      user: { id: user.id, email: user.email, emailVerified: false },
      token,
    });
  } catch (err) {
    captureError('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = req.cookies?.token || authHeader?.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.decode(token);
      if (decoded?.jti) revokedJtis.add(decoded.jti);
    } catch {}
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

// Verify email — called when user clicks the link in their email
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const record = await prisma.verificationToken.findUnique({ where: { token } });

    if (!record) return res.status(400).json({ error: 'Invalid or expired link' });
    if (record.expires < new Date()) {
      await prisma.verificationToken.delete({ where: { token } });
      return res.status(400).json({ error: 'Link has expired — please request a new one' });
    }

    // identifier format is "verify:email"
    const email = record.identifier.replace(/^verify:/, '');

    await prisma.user.update({
      where: { email },
      data: { emailVerified: new Date() },
    });

    await prisma.verificationToken.delete({ where: { token } });

    // Redirect to the frontend with a success flag
    res.redirect(`${process.env.APP_URL}/login?verified=1`);
  } catch (err) {
    captureError('verify-email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resend verification email
app.post('/api/auth/resend-verification', authLimiter, authenticateToken, resendVerificationLimiter, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified' });

    await sendVerificationEmail(user.email, user.name);
    res.json({ message: 'Verification email sent' });
  } catch (err) {
    captureError('resend-verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    // H4 — constant-time comparison to prevent user enumeration via timing
    const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const valid = user?.password ? await bcrypt.compare(password, user.password) : (await bcrypt.compare(password, DUMMY_HASH), false);
    if (!user || !user.password || !valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.status !== 'active') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });
    }

    const memberships = await prisma.teamMember.findMany({
      where: { userId: user.id },
      select: { teamId: true, role: true },
    });

    const token = jwt.sign(
      {
        jti: crypto.randomUUID(),
        name: user.name,
        id: user.id,
        email: user.email,
        teams: memberships,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      },
    );

    setAuthCookie(res, token);
    // token also returned in body for the Chrome extension (stored in chrome.storage.session).
    // The web app ignores data.token and relies on the httpOnly cookie instead.
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        teams: memberships,
      },
    });
  } catch (err) {
    captureError('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieOpts = {
    httpOnly: true,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    ...(isProd ? { secure: true, sameSite: 'none' } : { sameSite: 'lax' }),
  };
  res.cookie('token', token, cookieOpts);
  // Readable indicator so client JS can know a session exists without seeing the JWT
  res.cookie('has_session', '1', { ...cookieOpts, httpOnly: false });
}

function clearAuthCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const clearOpts = {
    httpOnly: true,
    path: '/',
    ...(isProd ? { secure: true, sameSite: 'none' } : { sameSite: 'lax' }),
  };
  res.clearCookie('token', clearOpts);
  res.clearCookie('has_session', { ...clearOpts, httpOnly: false });
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = req.cookies?.token || authHeader?.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Authentication required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    if (user.jti && revokedJtis.has(user.jti)) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    req.user = user;
    req.token = token;
    // Attach the authenticated user to Sentry scope so every error from
    // this request is tagged with who triggered it
    Sentry.setUser({ id: user.id, email: user.email, username: user.name });
    next();
  });
}

async function requireActivePlan(req, res, next) {
  try {
    // Get teamId from request body, or fall back to the first team the user belongs to
    let teamId = req.body.teamId;

    if (teamId) {
      // A client-supplied teamId must actually belong to this user — otherwise
      // someone could attach new sites/reports to (and consume the plan quota
      // of) a team they have no membership in.
      const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: req.user.id } });
      if (!membership) return res.status(403).json({ error: 'Access denied' });
    } else {
      const userWithTeams = await prisma.user.findUnique({
        where: { id: req.user.id },
        include: { teamMembers: true },
      });
      teamId = userWithTeams?.teamMembers?.[0]?.teamId;
    }

    if (!teamId) {
      return res.status(400).json({ error: 'No team selected' });
    }

    // Count of reports for this month (calendar month, UTC)
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Fetch the team along with subscription, members, and this-month report counts
    const [team, monthlyReportCount] = await Promise.all([
      prisma.team.findUnique({
        where: { id: teamId },
        include: {
          subscription: true,
          sites: { select: { id: true } },
          members: true,
        },
      }),
      prisma.qAReport.count({
        where: {
          site: { teamId },
          createdAt: { gte: startOfMonth },
        },
      }),
    ]);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // team.plan is the authoritative plan field — every checkout/webhook path
    // updates it alongside subscription.plan, but only team.plan is guaranteed
    // to exist (a Subscription row isn't created until first checkout).
    const plan = team.plan || 'free';
    const subscriptionStatus = team.subscription?.status || 'active';

    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    // Block inactive subscriptions — 'canceling' still has access until period end
    if (plan !== 'free' && subscriptionStatus !== 'active' && subscriptionStatus !== 'canceling') {
      return res.status(402).json({
        error: 'Your subscription is inactive. Please update billing.',
      });
    }

    const totalReports = monthlyReportCount;

    // Enforce report limit
    if (totalReports >= limits.reports) {
      return res.status(403).json({
        error: 'Report limit reached for this plan',
      });
    }

    // Enforce member limit (block invite when already at the limit)
    if (team.members.length >= limits.members) {
      return res.status(403).json({
        error: `Member limit reached for this plan (${limits.members} members)`,
      });
    }

    // Enforce site limit
    if (team.sites.length >= limits.sites) {
      return res.status(403).json({
        error: `Site limit reached for this plan (${limits.sites})`,
      });
    }

    // Attach info to request for downstream handlers
    req.teamPlan = {
      teamId,
      plan,
      limits,
      totalReports,
      members: team.members.length,
      sites: team.sites.length,
    };

    next();
  } catch (err) {
    captureError('Plan check failed', err);
    res.status(500).json({ error: 'Subscription check failed' });
  }
}

app.post('/sites/create', authenticateToken, requireActivePlan, async (req, res) => {
  const userId = req.user.id;
  const { name, url, teamId } = req.body;

  try {
    if (!name || !url) {
      return res.status(400).json({ error: 'Name and URL are required' });
    }

    // --- Extract domain from URL ---
    let domain;
    try {
      const parsed = new URL(url);
      domain = parsed.hostname.replace(/^www\./, '');
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // --- Generate slug from name ---
    const slug = stripTLD(url);

    // --- Create site ---
    const site = await prisma.site.create({
      data: {
        name,
        url,
        domain,
        slug,
        teamId: teamId || null,
        users: {
          connect: { id: userId }, // add creator as member
        },
      },
    });

    // --- Update last active ---
    await prisma.user.update({
      where: { id: userId },
      data: { lastActive: new Date() },
    });

    invalidateUserSites(userId);
    res.json({ site });
  } catch (err) {
    captureError('Create site error:', err);

    // Prisma unique constraint (domain must be unique)
    if (err.code === 'P2002') {
      return res
        .status(409)
        .json({ error: 'A site with this domain already exists' });
    }

    res.status(400).json({ error: 'Failed to create site' });
  }
});

app.post(
  '/teams/create',
  authenticateToken,
  uploadAttachments.single('logo'),
  async (req, res) => {
    const userId = req.user.id;
    const { name } = req.body; // M1 — ignore plan from client; always create as 'free'
    const file = req.file;

    try {
      let logoUrl = null;

      if (file) {
        // Generate a unique key for R2
        const sanitisedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'); // M5
        const key = `team-logos/${Date.now()}_${sanitisedName}`;

        // Upload to Cloudflare R2
        await uploadBufferToR2(file.buffer, key, file.mimetype);

        // Get a signed URL to serve publicly (optional)
        logoUrl = await getSignedR2Url(key);
      }
      const team = await prisma.team.create({
        data: {
          name,
          logo: logoUrl,
          plan: 'free', // M1 — always free on creation; ignore client-supplied plan
          members: {
            create: {
              userId,
              role: 'owner',
            },
          },
        },
      });

      await prisma.user.update({
        where: { id: req.user.id },
        data: { lastActive: new Date() },
      });

      res.json({ team });
    } catch (err) {
      res.status(400).json({ error: 'Failed to create team' });
    }
  },
);

const handleGenerateNewCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = [4, 4, 4].map((len) =>
    Array.from(
      { length: len },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join(''),
  );

  return `TEAM-${segments.join('-')}`;
};

app.post('/teams/:teamId/invite-link', authenticateToken, async (req, res) => {
  const { teamId } = req.params;
  const { role: requestedRole = 'member', oneTime = false } = req.body;

  try {
    // H1 — membership check
    const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: req.user.id } });
    if (!membership) return res.status(403).json({ error: 'Access denied' });

    // Only owners may mint owner-role invite links — otherwise any member could
    // generate a link that grants whoever opens it owner access.
    const safeRequestedRole = ['member', 'owner'].includes(requestedRole) ? requestedRole : 'member';
    const role = safeRequestedRole === 'owner' && membership.role !== 'owner' ? 'member' : safeRequestedRole;

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const code = handleGenerateNewCode();

    const invite = await prisma.teamInvite.create({
      data: { teamId, code, expiresAt, role, email: null, oneTime: !!oneTime },
    });

    res.json({
      code,
      oneTime: invite.oneTime,
      inviteUrl: `${process.env.APP_URL}/invite/${code}`,
    });
  } catch (error) {
    captureError('Failed to create invite link:', error);
    res.status(500).json({ error: 'Failed to create invite link' });
  }
});

app.get('/teams/:teamId/invite-link', authenticateToken, async (req, res) => {
  const { teamId } = req.params;
  const { role: requestedRole = 'member' } = req.body || {};

  // H4 — membership check
  const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: req.user.id } });
  if (!membership) return res.status(403).json({ error: 'Access denied' });

  const safeRequestedRole = ['member', 'owner'].includes(requestedRole) ? requestedRole : 'member';
  const role = safeRequestedRole === 'owner' && membership.role !== 'owner' ? 'member' : safeRequestedRole;

  try {
    // 1️⃣ Get most recent non-expired, not-yet-used invite
    const invite = await prisma.teamInvite.findFirst({
      where: {
        teamId,
        expiresAt: { gt: new Date() }, // still valid
        used: false, // a one-time link that's already been redeemed shouldn't be handed out again
      },
      orderBy: { createdAt: 'desc' },
    });

    if (invite) {
      return res.json({
        code: invite.code,
        oneTime: invite.oneTime,
        inviteUrl: `${process.env.APP_URL}/invite/${invite.code}`,
      });
    } else {
      // 3️⃣ Otherwise create a new one automatically
      const code = handleGenerateNewCode();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const newInvite = await prisma.teamInvite.create({
        data: { teamId, code, expiresAt, role, email: null },
      });

      res.json({
        code: newInvite.code,
        oneTime: newInvite.oneTime,
        inviteUrl: `${process.env.APP_URL}/invite/${newInvite.code}`,
      });
    }
  } catch (err) {
    captureError('Failed to load invite code', err);
    res.status(500).json({ error: 'Failed to load invite code' });
  }
});

const resend = new Resend(process.env.RESEND_API_KEY);

app.post(
  '/teams/:teamId/invite-email',
  authenticateToken,
  requireActivePlan,
  async (req, res) => {
    const { teamId } = req.params;
    const { email, role: requestedRole = 'member' } = req.body;

    // Only existing team owners can invite, and only with an allowed role —
    // closes a full team-takeover hole where any user could self-invite as owner.
    const isOwner = await prisma.teamMember.findFirst({
      where: { teamId, userId: req.user.id, role: 'owner' },
    });
    if (!isOwner) return res.status(403).json({ error: 'Only team owners can invite members' });

    const role = ['member', 'owner'].includes(requestedRole) ? requestedRole : 'member';

    const inviterName = req.user.name;
    const code = handleGenerateNewCode();

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    // optional 7-day expiry
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invite = await prisma.teamInvite.create({
      data: {
        teamId,
        email,
        code,
        expiresAt,
        role,
      },
    });

    if (invite.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Invite has expired' });
    }

    const inviteUrl = `${process.env.APP_URL}/invite/${code}`;

    const emailHtml = emailTemplate({
      badgeText: ‘Team Invite’,
      heading: `You’ve been invited to join ${team.name}`,
      body: `<p><strong style="color:#fff;">${inviterName}</strong> has invited you to collaborate on their QA workspace.</p>
             <p style="margin-top:12px;">Annoture helps teams capture website bugs visually, add comments, and manage them on a shared Kanban board.</p>
             <p style="margin-top:16px;font-size:12px;color:rgba(255,255,255,0.3);">This invite expires on <strong style="color:rgba(255,255,255,0.5);">${expiresAt.toLocaleDateString()}</strong>.</p>`,
      ctaUrl: inviteUrl,
      ctaLabel: ‘Accept invite and join the team’,
      footerNote: "You’re receiving this because someone added your email to an Annoture team invite. If you weren’t expecting this, you can safely ignore it.",
    });

    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Annoture <onboarding@resend.dev>',
      to: email,
      subject: `You’ve been invited to join ${team.name} on Annoture`,
      html: emailHtml,
    });

    res.json({ success: true });
  },
);

app.post('/teams/join', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { code } = req.body;

  try {
    const invite = await prisma.teamInvite.findUnique({
      where: { code },
      include: { team: true },
    });

    if (!invite) return res.status(400).json({ error: 'Invalid invite link' });

    // check expiry
    if (invite.expiresAt && invite.expiresAt < new Date())
      return res.status(400).json({ error: 'This invite has expired' });

    // email-specific invites are always single-use; link invites are reusable
    // unless explicitly marked one-time
    if ((invite.email !== null || invite.oneTime) && invite.used) {
      return res.status(400).json({ error: 'This invite has already been used' });
    }

    // prevent double-joining
    const existingMember = await prisma.teamMember.findFirst({
      where: { teamId: invite.teamId, userId },
    });

    if (existingMember) {
      return res.status(200).json({ joined: true, alreadyMember: true, teamName: invite.team.name });
    }

    // Enforce member limit before joining
    const [memberCount, teamForPlan] = await Promise.all([
      prisma.teamMember.count({ where: { teamId: invite.teamId } }),
      prisma.team.findUnique({
        where: { id: invite.teamId },
        include: { subscription: true },
      }),
    ]);
    const joinPlan = teamForPlan?.subscription?.plan || 'free';
    const joinLimits = PLAN_LIMITS[joinPlan] || PLAN_LIMITS.free;
    if (memberCount >= joinLimits.members) {
      return res.status(403).json({
        error: `This team has reached its ${joinLimits.members}-member limit on the ${joinPlan} plan. Ask the team owner to upgrade.`,
      });
    }

    const ops = [
      prisma.teamMember.create({
        data: { teamId: invite.teamId, userId, role: invite.role },
      }),
    ];

    // Only mark as used for single-use invites (email-specific or one-time links)
    if (invite.email !== null || invite.oneTime) {
      ops.push(prisma.teamInvite.update({ where: { id: invite.id }, data: { used: true } }));
    }

    await prisma.$transaction(ops);

    res.json({ joined: true, teamName: invite.team.name });
  } catch (error) {
    captureError('Failed to join team:', error);
    res.status(500).json({ error: 'Failed to join team' });
  }
});

app.get('/teams/:teamId/members', authenticateToken, async (req, res) => {
  const { teamId } = req.params;

  try {
    // H2 — membership check
    const isMember = await prisma.teamMember.findFirst({ where: { teamId, userId: req.user.id } });
    if (!isMember) return res.status(403).json({ error: 'Access denied' });

    const members = await prisma.teamMember.findMany({
      where: { teamId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            status: true, // e.g. "active", "invited", "disabled"
            lastActive: true, // Date field you update on activity
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const result = members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      status: m.user.status ?? 'active',
      lastActive: m.user.lastActive,
    }));

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({ members: result });
  } catch (err) {
    captureError(err);
    res.status(500).json({ error: 'Failed to load team members' });
  }
});

app.delete('/teams/:teamId/members/:userId', authenticateToken, async (req, res) => {
  const { teamId, userId } = req.params;
  const callerId = req.user.id;

  try {
    // Only team owners can remove members
    const callerMembership = await prisma.teamMember.findFirst({
      where: { teamId, userId: callerId },
    });
    if (!callerMembership || callerMembership.role !== 'owner') {
      return res.status(403).json({ error: 'Only team owners can remove members' });
    }

    // Cannot remove the last owner
    const targetMembership = await prisma.teamMember.findFirst({
      where: { teamId, userId },
    });
    if (!targetMembership) {
      return res.status(404).json({ error: 'Member not found in this team' });
    }
    if (targetMembership.role === 'owner') {
      const ownerCount = await prisma.teamMember.count({ where: { teamId, role: 'owner' } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner of a team' });
      }
    }

    await prisma.teamMember.delete({
      where: { userId_teamId: { userId, teamId } },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const user = await getUserTeams(userId);

    if (!user) return res.sendStatus(404);

    const firstMembership = user.teamMembers?.[0] ?? null;
    const ownedTeam = firstMembership?.team ?? null;
    const teamId = ownedTeam?.id ?? null;
    const isOwner = firstMembership?.role === 'owner';

    // Update last active
    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        teamId,
        team: ownedTeam
          ? {
              id: ownedTeam.id,
              name: ownedTeam.name,
              plan: ownedTeam.plan,
              subscription: ownedTeam.subscription ?? null,
            }
          : null,
        role: isOwner ? 'owner' : 'member',
        emailVerified: !!user.emailVerified,
        notificationPrefs: user.notificationPrefs ?? null,
        lastSeenNotificationsAt: user.lastSeenNotificationsAt ?? null,
      },
    });
  } catch (error) {
    captureError('Failed to get current user:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /api/notifications/mark-seen — records that the user has seen all
// notifications up to now, so the toast watcher doesn't replay them.
// DELETE /teams/:teamId — permanently delete a team and all its data.
// Only the team owner can do this. Cancels Stripe subscription and deletes R2 files.
app.delete('/teams/:teamId', authenticateToken, async (req, res) => {
  const { teamId } = req.params;
  const callerId = req.user.id;

  try {
    // Only the owner may delete the team
    const membership = await prisma.teamMember.findFirst({
      where: { teamId, userId: callerId, role: 'owner' },
    });
    if (!membership) {
      return res.status(403).json({ error: 'Only the team owner can delete this team' });
    }

    // Fetch everything we need to clean up
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        subscription: true,
        sites: {
          select: {
            id: true,
            reports: { select: { id: true, imagePath: true, videoPath: true } },
          },
        },
      },
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    // 1. Cancel Stripe subscription if active
    if (team.subscription?.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.cancel(team.subscription.stripeSubscriptionId);
      } catch (stripeErr) {
        captureError('Stripe cancel on team delete failed', stripeErr);
        // Non-fatal — continue with DB cleanup
      }
    }

    // 2. Delete R2 objects for all reports across all team sites
    const allReports = team.sites.flatMap((s) => s.reports);
    const r2Keys = allReports.flatMap((r) => {
      const keys = [];
      if (r.imagePath) { const k = keyFromSignedUrl(r.imagePath); if (k) keys.push(k); }
      if (r.videoPath) { const k = keyFromSignedUrl(r.videoPath); if (k) keys.push(k); }
      return keys;
    });
    if (r2Keys.length) {
      try { await deleteObjectsFromR2(r2Keys); } catch (r2Err) {
        captureError('R2 cleanup on team delete failed', r2Err);
      }
    }

    // 3. Delete all DB records in dependency order
    const siteIds = team.sites.map((s) => s.id);
    const reportIds = allReports.map((r) => r.id);

    await prisma.$transaction([
      // Reports and their children
      prisma.attachment.deleteMany({ where: { qAReportId: { in: reportIds } } }),
      prisma.comment.deleteMany({ where: { reportId: { in: reportIds } } }),
      prisma.activity.deleteMany({ where: { reportId: { in: reportIds } } }),
      prisma.qAReport.deleteMany({ where: { siteId: { in: siteIds } } }),
      // Site-level
      prisma.kanbanColumn.deleteMany({ where: { siteId: { in: siteIds } } }),
      prisma.boardAccess.deleteMany({ where: { siteId: { in: siteIds } } }),
      prisma.boardInvite.deleteMany({ where: { siteId: { in: siteIds } } }),
      prisma.siteUser.deleteMany({ where: { siteId: { in: siteIds } } }),
      prisma.notification.deleteMany({ where: { siteId: { in: siteIds } } }),
      prisma.site.deleteMany({ where: { id: { in: siteIds } } }),
      // Team-level
      prisma.teamMember.deleteMany({ where: { teamId } }),
      prisma.teamInvite.deleteMany({ where: { teamId } }),
      prisma.subscription.deleteMany({ where: { teamId } }),
      prisma.team.delete({ where: { id: teamId } }),
    ]);

    res.json({ deleted: true });
  } catch (err) {
    captureError('DELETE /teams/:teamId error', err);
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

app.post('/api/notifications/mark-seen', authenticateToken, async (req, res) => {
  try {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { lastSeenNotificationsAt: new Date() },
      select: { lastSeenNotificationsAt: true },
    });
    res.json({ lastSeenNotificationsAt: updated.lastSeenNotificationsAt });
  } catch (error) {
    captureError('Failed to mark notifications seen:', error);
    res.status(500).json({ error: 'Failed to mark notifications seen' });
  }
});

app.post(
  '/api/report',
  authenticateToken,
  uploadLimiter,
  uploadAttachments.fields([
    { name: 'screenshot', maxCount: 1 },
    { name: 'video', maxCount: 1 },       // optional — agency plan only
  ]),
  requireActivePlan,
  async (req, res) => {
    const { url, comment, x, y, title, priority, type, dueDate, teamId, pageTitle, browser, os, screenSize, viewport, cssPath, consoleLogs } =
      req.body;
    const screenshotFile = req.files?.screenshot?.[0];
    const videoFile      = req.files?.video?.[0];

    if (!screenshotFile) return res.status(400).json({ error: 'No screenshot uploaded' });

    // consoleLogs arrives as a JSON string from the extension, already redacted client-side.
    // Re-validate shape/size server-side too — never trust the client as the only guard.
    let parsedConsoleLogs = null;
    if (consoleLogs) {
      try {
        const parsed = JSON.parse(consoleLogs);
        if (Array.isArray(parsed)) {
          parsedConsoleLogs = parsed
            .slice(-25)
            .filter((entry) => entry && typeof entry.message === 'string')
            .map((entry) => ({
              level: entry.level === 'warn' ? 'warn' : 'error',
              message: String(entry.message).slice(0, 500),
              timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
            }));
        }
      } catch {
        parsedConsoleLogs = null; // malformed payload — drop silently rather than fail the report
      }
    }

    const domain = new URL(url).hostname.replace('www.', '');
    const siteName = pageTitle || domain;

    try {
      // Determine team from JWT (synchronous — no DB hit)
      const userTeamId = teamId || getUserTeamIds(req)[0];
      if (!userTeamId)
        return res.status(400).json({ error: 'No team available' });

      // Run user/team validation and R2 uploads in parallel
      const screenshotKey = `screenshots/${Date.now()}_${screenshotFile.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

      // Video is only stored for agency-plan teams — check subscription inline to avoid
      // uploading a potentially large file that will just get discarded.
      const sub = videoFile
        ? await prisma.subscription.findUnique({ where: { teamId: userTeamId }, select: { plan: true } })
        : null;
      const isAgency = sub?.plan === 'agency' || sub?.plan === 'team';
      const videoKey = (videoFile && isAgency)
        ? `recordings/${Date.now()}_recording.webm`
        : null;

      const uploads = [
        prisma.user.findUnique({ where: { id: req.user.id } }),
        prisma.team.findUnique({ where: { id: userTeamId } }),
        uploadBufferToR2(screenshotFile.buffer, screenshotKey, screenshotFile.mimetype),
        videoKey ? uploadBufferToR2(videoFile.buffer, videoKey, 'video/webm') : Promise.resolve(null),
      ];

      const [user, team] = await Promise.all(uploads);

      if (!user) return res.status(400).json({ error: 'User not found' });
      if (!team) return res.status(400).json({ error: 'Team not found' });

      const slug = stripTLD(url);

      const { pathname } = new URL(url);
      const pagePath = pathname === '' ? '/' : pathname;

      // Create report
      const report = await prisma.qAReport.create({
        data: {
          url,
          site: domain,
          pagePath,
          slug,
          siteName,
          title,
          pageTitle,
          browser,
          os,
          screenSize,
          viewport,
          cssPath: cssPath || null,
          consoleLogs: parsedConsoleLogs,
          videoPath: videoKey || null,
          priority,
          type,
          dueDate: dueDate ? new Date(dueDate) : null,
          comment,
          x: parseInt(x),
          y: parseInt(y),
          imagePath: screenshotKey,
          userName: req.user.name,
          user: { connect: { id: req.user.id } },
          Site: {
            connectOrCreate: {
              where: { domain }, // make sure domain is @unique in Prisma
              create: {
                url,
                name: siteName,
                domain,
                slug,
                teamId: userTeamId,
                users: { connect: { id: req.user.id } },
              },
            },
          },
        },
      });

      // Respond immediately — fire remaining tasks without blocking
      res.json(report);

      // Invalidate cached stats + sites for this user so dashboard reflects new report
      invalidateUserStats(req.user.id);
      invalidateUserSites(req.user.id);

      // Non-blocking: update lastActive after response
      prisma.user.update({
        where: { id: req.user.id },
        data: { lastActive: new Date() },
      }).catch((err) => captureError('lastActive update failed:', err));

      // Notify all clients viewing this site's board in real time
      io.to(`site:${slug}`).emit('board:event', {
        type: 'report:created',
        reportId: report.id,
      });
    } catch (error) {
      captureError('Error saving report:', error);
      res.status(500).json({ error: 'Failed to save report' });
    }
  },
);

app.get('/api/report', authenticateToken, async (req, res) => {
  try {
    const reports = await prisma.qAReport.findMany({
      where: {
        userId: req.user.id,
      },
      orderBy: {
        timestamp: 'desc',
      },
      select: {
        id: true,
        imagePath: true,
        title: true,
        priority: true,
        type: true,
        comment: true,
        url: true,
        site: true,
        dueDate: true,
        slug: true,
        siteName: true,
        x: true,
        y: true,
        timestamp: true,
        userId: true,
        userName: true,

        // 🔗 pull Site info for grouping
        Site: {
          select: {
            id: true,
            name: true,
            domain: true,
            slug: true,
          },
        },
      },
    });

    // 🧩 Group reports by siteId
    const grouped = Object.values(
      reports.reduce((acc, report) => {
        const site = report.Site;
        const siteId = site?.id || 'unknown';

        if (!acc[siteId]) {
          acc[siteId] = {
            siteId,
            siteName: site?.name || report.siteName || report.site,
            domain: site?.domain || report.site || null,
            slug: site?.slug || null,
            reports: [],
          };
        }

        acc[siteId].reports.push({
          id: report.id,
          imagePath: report.imagePath, // re-signed below
          title: report.title,
          priority: report.priority,
          type: report.type,
          comment: report.comment,
          url: report.url,
          site: report.site,
          dueDate: report.dueDate ? report.dueDate.toISOString() : null,
          slug: report.slug,
          siteName: report.siteName,
          x: report.x,
          y: report.y,
          timestamp: report.timestamp.toISOString(),
          userId: report.userId,
          userName: report.userName,
        });

        return acc;
      }, {}),
    );

    // Re-sign screenshot URLs for all grouped reports
    await Promise.all(
      grouped.flatMap((g) =>
        g.reports.map(async (r) => {
          r.imagePath = await refreshR2Url(r.imagePath);
        })
      )
    );

    // 👤 update activity
    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(grouped);
  } catch (error) {
    captureError('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

app.get('/api/report/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const report = await prisma.qAReport.findFirst({
      where: {
        id,
        OR: [
          // ✅ Report owner
          { userId },

          // ✅ Team member of the board's owning team
          {
            Site: {
              team: {
                members: {
                  some: { userId },
                },
              },
            },
          },

          // ✅ Board-level guest (BoardAccess)
          {
            Site: {
              boardAccesses: {
                some: { userId },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        imagePath: true,
        title: true,
        status: true,
        priority: true,
        type: true,
        comment: true,
        url: true,
        site: true,
        pagePath: true,
        dueDate: true,
        slug: true,
        siteName: true,
        x: true,
        y: true,
        timestamp: true,
        userId: true,
        userName: true,
        browser: true,
        os: true,
        screenSize: true,
        viewport: true,
        cssPath: true,
        consoleLogs: true,
        videoPath: true,
      },
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({
      ...report,
      imagePath: await refreshR2Url(report.imagePath),
      videoPath: await refreshR2Url(report.videoPath),
      dueDate: report.dueDate ? report.dueDate.toISOString() : null,
      timestamp: report.timestamp.toISOString(),
    });
  } catch (error) {
    captureError('Error fetching report:', error);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// GET /api/sites
app.get('/api/sites', authenticateToken, cacheMiddleware((req) => `sites:${req.user.id}:${req.query.teamId || ''}`, TTL.SITES), async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;

  try {
    // 1️⃣ Get sites scoped to the active team (or all accessible sites if no teamId)
    const teamFilter = teamId
      ? { teamId }
      : { OR: [{ users: { some: { id: userId } } }, { team: { members: { some: { userId } } } }] };

    const ownedSites = await prisma.site.findMany({
      where: teamFilter,
      select: {
        id: true,
        domain: true,
        slug: true,
        siteUsers: { where: { userId }, select: { isPinned: true } },
      },
    });

    // 1b️⃣ Also include boards shared with this user via BoardAccess (scoped to team if provided)
    const sharedAccesses = await prisma.boardAccess.findMany({
      where: { userId, ...(teamId ? { site: { teamId } } : {}) },
      include: {
        site: {
          select: {
            id: true,
            domain: true,
            slug: true,
            siteUsers: { where: { userId }, select: { isPinned: true } },
          },
        },
      },
    });
    const sharedSites = sharedAccesses.map((a) => ({ ...a.site, isShared: true, sharedRole: a.role }));

    const accessibleSites = [
      ...ownedSites.map((s) => ({ ...s, isShared: false, sharedRole: null })),
      ...sharedSites,
    ];

    // Deduplicate by domain
    const uniqueSites = [];
    const seenDomains = new Set();
    for (const site of accessibleSites) {
      if (!seenDomains.has(site.domain)) {
        seenDomains.add(site.domain);
        uniqueSites.push(site);
      }
    }

    const domains = uniqueSites.map((s) => s.domain);

    // 2️⃣ Aggregate counts and priorities per site
    const reports = await prisma.qAReport.groupBy({
      by: ['site', 'status', 'priority', 'archived'],
      where: { site: { in: domains } },
      _count: { _all: true },
    });

    const siteData = {};
    reports.forEach((r) => {
      if (!siteData[r.site]) {
        siteData[r.site] = {
          counts: { new: 0, inProgress: 0, done: 0 },
          priorities: { low: 0, medium: 0, high: 0, urgent: 0 },
          archived: true,
        };
      }
      siteData[r.site].counts[r.status] = r._count._all;
      siteData[r.site].priorities[r.priority] += r._count._all;
      if (!r.archived) siteData[r.site].archived = false;
    });

    // 3️⃣ Get members per site
    const sitesWithMembers = await prisma.site.findMany({
      where: { domain: { in: domains } },
      select: {
        domain: true,
        users: { select: { id: true, email: true, name: true } },
      },
    });

    const membersByDomain = {};
    sitesWithMembers.forEach((site) => {
      membersByDomain[site.domain] = site.users;
    });

    // 4️⃣ Get latest report per site
    const latestReports = await prisma.qAReport.findMany({
      where: { site: { in: domains } },
      orderBy: { timestamp: 'desc' },
      distinct: ['site'],
      select: { id: true, site: true, siteName: true, timestamp: true },
    });

    const latestMap = {};
    latestReports.forEach((r) => {
      latestMap[r.site] = r;
    });

    // 5️⃣ Build final site list
    const sitesWithDetails = uniqueSites.map((site) => {
      const counts = siteData[site.domain]?.counts || {
        new: 0,
        inProgress: 0,
        done: 0,
      };
      const priorities = siteData[site.domain]?.priorities || {
        low: 0,
        medium: 0,
        high: 0,
        urgent: 0,
      };
      const latest = latestMap[site.domain];

      const totalReports = Object.values(counts).reduce((a, b) => a + b, 0);

      return {
        id: latest?.id || null,
        site: site.domain,
        slug: site.slug ?? site.domain,
        siteName: latest?.siteName || site.domain,
        members: membersByDomain[site.domain] || [],
        counts,
        priorities,
        total: totalReports,
        lastUpdated: latest?.timestamp || null,
        isPinned: site.siteUsers[0]?.isPinned ?? false,
        siteStatus: siteData[site.domain]?.archived ? 'archived' : 'active',
        isShared: site.isShared ?? false,
        sharedRole: site.sharedRole ?? null,
      };
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(sitesWithDetails);
  } catch (error) {
    captureError('Error fetching accessible sites:', error);
    res.status(500).json({ error: 'Failed to fetch sites' });
  }
});

app.post('/api/site/:slug/pin', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { slug } = req.params;
  const { isPinned } = req.body;

  try {
    // Find the site by slug
    const site = await prisma.site.findFirst({
      where: { slug },
      select: { id: true, teamId: true },
    });

    if (!site) {
      return res
        .status(404)
        .json({ error: `Site with slug "${slug}" not found` });
    }

    const hasAccess =
      (site.teamId && (await prisma.teamMember.findFirst({ where: { teamId: site.teamId, userId } }))) ||
      (await prisma.boardAccess.findUnique({ where: { siteId_userId: { siteId: site.id, userId } } }));
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    await prisma.siteUser.upsert({
      where: { userId_siteId: { userId, siteId: site.id } },
      update: { isPinned },
      create: { userId, siteId: site.id, isPinned },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    captureError('Failed to pin site:', err); // This will log the actual error
    res.status(500).json({ error: 'Failed to pin site' });
  }
});

app.post('/api/site/:slug/unpin', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { slug } = req.params;

  try {
    // Find the site by slug
    const site = await prisma.site.findFirst({
      where: { slug },
      select: { id: true },
    });

    if (!site) {
      return res
        .status(404)
        .json({ error: `Site with slug "${slug}" not found` });
    }

    // Update the SiteUser record if it exists
    const updated = await prisma.siteUser.updateMany({
      where: { userId, siteId: site.id },
      data: { isPinned: false },
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Pin not found for this user' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({ success: true, message: `Site "${slug}" unpinned` });
  } catch (err) {
    captureError('Failed to unpin site:', err);
    res.status(500).json({ error: 'Failed to unpin site' });
  }
});

app.get('/api/users-tasks', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;

  try {
    // Step 1: Get sites for the active team (or all accessible sites if no teamId)
    const siteDomains = await getTeamSiteDomains(userId, teamId);

    if (!siteDomains.length) return res.json([]);

    // Step 2: Get all reports for those sites assigned to this user
    const [reports, customColumns] = await Promise.all([
      prisma.qAReport.findMany({
        where: {
          site: { in: siteDomains },
          archived: false,
          status: { not: 'done' },
          userId: userId,
        },
        orderBy: { timestamp: 'desc' },
        take: 500,
      }),
      prisma.kanbanColumn.findMany({
        where: { site: { domain: { in: siteDomains } } },
        select: { id: true, name: true },
      }),
    ]);

    const columnNameMap = Object.fromEntries(customColumns.map((c) => [c.id, c.name]));

    // Helper: map status -> color
    const statusColors = {
      new: 'blue',
      inProgress: 'yellow',
      done: 'green',
      qa: 'purple',
    };

    // Helper: convert dates nicely
    function formatDate(date) {
      const today = new Date();
      const input = new Date(date);
      const isToday = today.toDateString() === input.toDateString();
      if (isToday) return 'Today';
      return input.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }

    // Step 3: Transform into your TASK format
    const tasks = reports.map((r) => ({
      id: r.id,
      title: r.comment || 'Untitled Task',
      status: r.status || 'Open',
      statusLabel: columnNameMap[r.status] ?? null,
      priority: r.priority || 'Medium',
      dueDate: formatDate(r.timestamp),
      project: r.siteName || r.site,
      statusColor: statusColors[r.status] || 'purple',
    }));

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(tasks);
  } catch (error) {
    captureError('Error generating tasks:', error);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

app.get('/api/tasks', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;

  try {
    /**
     * 1️⃣ Get all sites scoped to the active team
     */
    const siteDomains = await getTeamSiteDomains(userId, teamId);

    if (!siteDomains.length) {
      return res.json([]);
    }

    /**
     * 2️⃣ Fetch all NON-ARCHIVED tasks assigned to this user across those sites
     */
    const [reports, customColumns] = await Promise.all([
      prisma.qAReport.findMany({
        where: {
          site: { in: siteDomains },
          archived: false,
          userId,
        },
        orderBy: { timestamp: 'desc' },
        take: 500,
        include: {
          user: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.kanbanColumn.findMany({
        where: { site: { domain: { in: siteDomains } } },
        select: { id: true, name: true },
      }),
    ]);

    const columnNameMap = Object.fromEntries(customColumns.map((c) => [c.id, c.name]));

    /**
     * 3️⃣ Transform into frontend-friendly TASK shape
     */
    const statusColors = {
      new: 'blue',
      inProgress: 'yellow',
      qa: 'purple',
      done: 'green',
    };

    const tasks = reports.map((r) => ({
      id: r.id,
      title: r.title,
      comment: r.comment,
      status: r.status,
      statusLabel: columnNameMap[r.status] ?? null,
      priority: r.priority || 'medium',
      site: r.site,
      siteName: r.siteName || r.site,
      createdBy: {
        id: r.user?.id,
        name: r.user?.name,
      },
      createdAt: r.timestamp,
      statusColor: statusColors[r.status] || 'purple',
      dueDate: r.dueDate,
      slug: r.slug,
    }));

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(tasks);
  } catch (error) {
    captureError('Failed to fetch tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

app.get('/api/archive', authenticateToken, async (req, res) => {
  const userId = req.user.id; // assuming user is attached to req (e.g. via middleware)

  try {
    const archivedReports = await prisma.qAReport.findMany({
      where: {
        archived: true,
        userId,
      },
      orderBy: {
        archivedAt: 'desc',
      },
      take: 200,
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(archivedReports);
  } catch (error) {
    captureError('Failed to fetch archived reports:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/site/:site
app.get('/api/site/:slug', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { teamId } = req.query;

  try {
    const siteExists = await prisma.site.findFirst({
      where: { OR: [{ slug }, { domain: slug }] },
      select: { id: true },
    });
    if (!siteExists) {
      return res.status(404).json({ error: 'Site not found' });
    }

    const site = await resolveSiteForUser(slug, teamId, req.user.id);
    if (!site) {
      return res.status(403).json({ error: 'Access denied to this site' });
    }

    const reports = await prisma.qAReport.findMany({
      where: { siteId: site.id },
      orderBy: { timestamp: 'desc' },
    });

    // Re-sign screenshot and video URLs so they never expire regardless of
    // when the report was originally created.
    const refreshed = await Promise.all(
      reports.map(async (r) => ({
        ...r,
        imagePath: await refreshR2Url(r.imagePath),
        videoPath: await refreshR2Url(r.videoPath),
      }))
    );

    res.json(refreshed);
  } catch (error) {
    captureError('Failed to get site reports:', error);
    res.status(500).json({ error: 'Failed to get site' });
  }
});

// GET /api/site/:slug/public-status — intentionally public (powers the /status/:slug page).
// Slugs are generated from site names, not secrets; leaking aggregate report counts is
// an accepted trade-off for the public-facing status board feature.
app.get('/api/site/:slug/public-status', apiLimiter, async (req, res) => {
  try {
    const site = await prisma.site.findFirst({ where: { slug: req.params.slug } });
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const reports = await prisma.qAReport.findMany({
      where: { site: site.domain },
      select: { status: true, priority: true, timestamp: true },
    });

    const counts = { new: 0, inProgress: 0, done: 0 };
    const priorities = { urgent: 0, high: 0, medium: 0, low: 0, 'not assigned': 0 };

    for (const r of reports) {
      if (r.status in counts) counts[r.status]++;
      else counts[r.status] = (counts[r.status] || 0) + 1; // custom columns
      const p = r.priority || 'not assigned';
      if (p in priorities) priorities[p]++;
      else priorities['not assigned']++;
    }

    const total = reports.length;
    const lastUpdated = reports.length > 0
      ? reports.reduce((latest, r) => r.timestamp > latest ? r.timestamp : latest, reports[0].timestamp)
      : null;

    res.json({
      siteName: site.siteName || site.domain,
      siteUrl: site.domain,
      slug: site.slug,
      total,
      counts,
      priorities,
      lastUpdated,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Invite a user to collaborate on a site
app.post('/api/site/:slug/invite', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { email, userId } = req.body;

  if (!slug || !email) {
    return res.status(400).json({ error: 'slug and email are required' });
  }

  if (!slug || (!email && !userId)) {
    return res.status(400).json({ error: 'Provide either email or userId' });
  }

  try {
    // 1. Load site — teamId is derived from the site itself, never trusted from the client
    const site = await prisma.site.findFirst({
      where: { slug },
      select: { id: true, teamId: true },
    });

    if (!site) {
      return res.status(404).json({ error: 'Site not found' });
    }

    const isAdmin = await prisma.teamMember.findFirst({
      where: { teamId: site.teamId, userId: req.user.id, role: 'owner' },
    });
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only admins can invite users' });
    }

    // 1. Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
    });

    // H5 — don't reveal whether email is registered; silently succeed if not found
    if (!user) {
      return res.json({ message: 'If that email is registered, an invite has been sent.' });
    }

    // 3. Connect user to site (many-to-many)
    await prisma.site.update({
      where: { id: site.id },
      data: {
        users: {
          connect: { id: user.id },
        },
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    return res.json({ message: 'If that email is registered, an invite has been sent.' });
  } catch (error) {
    captureError('Error inviting user:', error);
    return res.status(500).json({ error: 'Unable to invite user to site' });
  }
});

// ── Board sharing ──────────────────────────────────────────────────────────────

// POST /api/site/:slug/share  — invite someone by email to a specific board
app.post('/api/site/:slug/share', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { email, role = 'viewer' } = req.body;

  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!['viewer', 'commenter', 'editor'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const site = await prisma.site.findFirst({
      where: { slug },
      select: { id: true, teamId: true, name: true, slug: true },
    });
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Requester must own or be a member of the team that owns this board
    const membership = await prisma.teamMember.findFirst({
      where: { teamId: site.teamId, userId: req.user.id },
    });
    if (!membership) return res.status(403).json({ error: 'Access denied' });

    // Don't invite someone who is already a member of the owning team
    const invitee = await prisma.user.findUnique({ where: { email } });
    if (invitee) {
      const alreadyMember = await prisma.teamMember.findFirst({
        where: { teamId: site.teamId, userId: invitee.id },
      });
      if (alreadyMember) {
        return res.status(409).json({ error: 'This user is already a team member and has full access' });
      }

      // Grant access immediately if they already have an account
      await prisma.boardAccess.upsert({
        where: { siteId_userId: { siteId: site.id, userId: invitee.id } },
        update: { role },
        create: { siteId: site.id, userId: invitee.id, role, invitedById: req.user.id },
      });
      // Bust the invitee's sites cache so they see the board immediately
      invalidateUserSites(invitee.id);
    }

    // Always create/update an invite record (so we can email them)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invite = await prisma.boardInvite.create({
      data: { siteId: site.id, email, role, invitedById: req.user.id, expiresAt },
    });

    const inviteUrl = `${process.env.APP_URL}/board-invite/${invite.token}`;
    const inviterName = req.user.name || 'A teammate';
    const roleName = role.charAt(0).toUpperCase() + role.slice(1);

    const fromAddress = process.env.EMAIL_FROM || 'Annoture <onboarding@resend.dev>';

    // Send email non-blocking — invite record is already created, don't fail if email errors
    resend.emails.send({
      from: fromAddress,
      to: email,
      subject: `${inviterName} shared a board with you on Annoture`,
      html: emailTemplate({
        badgeText: 'Board Access',
        heading: `${inviterName} invited you to view a board`,
        body: `<p>You've been given <strong style="color:#a78bfa;">${roleName}</strong> access to the <strong style="color:#fff;">${site.name}</strong> board.</p>
               <p style="margin-top:16px;font-size:12px;color:rgba(255,255,255,0.3);">This invite expires on <strong style="color:rgba(255,255,255,0.5);">${expiresAt.toLocaleDateString()}</strong>.</p>`,
        ctaUrl: inviteUrl,
        ctaLabel: 'Open board',
        footerNote: "If you weren't expecting this invite, you can safely ignore it.",
      }),
    }).then(({ error }) => {
      if (error) captureError('board share email error:', error);
    }).catch((err) => captureError('board share email exception:', err));

    res.json({ success: true, inviteUrl, message: invitee ? 'Access granted and invite sent' : 'Invite sent — they\'ll get access when they sign up' });
  } catch (err) {
    captureError('board share error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// GET /api/site/:slug/share  — list who has board-level guest access
app.get('/api/site/:slug/share', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  try {
    const site = await prisma.site.findFirst({
      where: { slug },
      select: { id: true, teamId: true },
    });
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const membership = await prisma.teamMember.findFirst({
      where: { teamId: site.teamId, userId: req.user.id },
    });
    if (!membership) return res.status(403).json({ error: 'Access denied' });

    const accesses = await prisma.boardAccess.findMany({
      where: { siteId: site.id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const pending = await prisma.boardInvite.findMany({
      where: { siteId: site.id, used: false, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ accesses, pending });
  } catch (err) {
    captureError('board share list error:', err);
    res.status(500).json({ error: 'Failed to load access list' });
  }
});

// PATCH /api/site/:slug/share/:userId  — change a guest's role
app.patch('/api/site/:slug/share/:userId', authenticateToken, async (req, res) => {
  const { slug, userId } = req.params;
  const { role } = req.body;
  if (!['viewer', 'commenter', 'editor'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  try {
    const site = await prisma.site.findFirst({ where: { slug }, select: { id: true, teamId: true } });
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const membership = await prisma.teamMember.findFirst({
      where: { teamId: site.teamId, userId: req.user.id },
    });
    if (!membership) return res.status(403).json({ error: 'Access denied' });

    await prisma.boardAccess.update({
      where: { siteId_userId: { siteId: site.id, userId } },
      data: { role },
    });
    res.json({ success: true });
  } catch (err) {
    captureError('board share patch error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// DELETE /api/site/:slug/share/:userId  — revoke a guest's access
app.delete('/api/site/:slug/share/:userId', authenticateToken, async (req, res) => {
  const { slug, userId } = req.params;
  try {
    const site = await prisma.site.findFirst({ where: { slug }, select: { id: true, teamId: true } });
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const membership = await prisma.teamMember.findFirst({
      where: { teamId: site.teamId, userId: req.user.id },
    });
    if (!membership) return res.status(403).json({ error: 'Access denied' });

    await prisma.boardAccess.delete({
      where: { siteId_userId: { siteId: site.id, userId } },
    });
    res.json({ success: true });
  } catch (err) {
    captureError('board share delete error:', err);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

// POST /api/board-invite/:token/accept  — accept a board invite link
app.post('/api/board-invite/:token/accept', authenticateToken, async (req, res) => {
  const { token } = req.params;
  try {
    // Fetch invite first so we can return friendly errors outside the transaction
    const invite = await prisma.boardInvite.findUnique({
      where: { token },
      include: { site: { select: { id: true, slug: true, name: true } } },
    });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.expiresAt < new Date()) return res.status(410).json({ error: 'This invite has expired' });

    // Mark as used and create access atomically to prevent double-acceptance
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.boardInvite.findUnique({ where: { token }, select: { used: true } });
      if (fresh?.used) throw Object.assign(new Error('ALREADY_USED'), { status: 410 });
      await tx.boardInvite.update({ where: { token }, data: { used: true } });
      await tx.boardAccess.upsert({
        where: { siteId_userId: { siteId: invite.siteId, userId: req.user.id } },
        update: { role: invite.role },
        create: { siteId: invite.siteId, userId: req.user.id, role: invite.role, invitedById: invite.invitedById },
      });
    });

    invalidateUserSites(req.user.id);
    res.json({ success: true, slug: invite.site.slug, siteName: invite.site.name });
  } catch (err) {
    if (err.message === 'ALREADY_USED') return res.status(410).json({ error: 'This invite has already been used' });
    captureError('board invite accept error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// GET /api/me/shared-boards  — boards shared with the current user from other teams
app.get('/api/me/shared-boards', authenticateToken, async (req, res) => {
  try {
    const accesses = await prisma.boardAccess.findMany({
      where: { userId: req.user.id },
      include: {
        site: {
          select: {
            id: true, name: true, slug: true, domain: true,
            team: { select: { name: true } },
            reports: { select: { id: true, status: true }, where: { archived: false } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(accesses.map(a => ({
      id: a.siteId,
      role: a.role,
      slug: a.site.slug,
      name: a.site.name,
      domain: a.site.domain,
      teamName: a.site.team?.name,
      totalReports: a.site.reports.length,
    })));
  } catch (err) {
    captureError('shared boards error:', err);
    res.status(500).json({ error: 'Failed to load shared boards' });
  }
});

// ── End board sharing ───────────────────────────────────────────────────────────

// Get all users who have access to a site
app.get('/api/site/:slug/users', authenticateToken, async (req, res) => {
  const { slug } = req.params;

  if (!slug) {
    return res.status(400).json({ error: 'slug is required' });
  }

  try {
    const site = await prisma.site.findFirst({
      where: { OR: [{ slug }, { domain: slug }] },
      select: {
        id: true,
        teamId: true,
        users: { select: { id: true, name: true, email: true } },
        boardAccesses: {
          select: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });

    if (!site) {
      return res.status(404).json({ error: 'Site not found' });
    }

    const hasAccess =
      (site.teamId && (await prisma.teamMember.findFirst({ where: { teamId: site.teamId, userId: req.user.id } }))) ||
      (await prisma.boardAccess.findUnique({ where: { siteId_userId: { siteId: site.id, userId: req.user.id } } }));
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    // Team members
    const teamMembers = site.teamId
      ? await prisma.teamMember.findMany({
          where: { teamId: site.teamId },
          select: { user: { select: { id: true, name: true, email: true } } },
        })
      : [];

    // Merge: site.users + team members + board guests, deduplicated by id
    const seen = new Set();
    const all = [
      ...site.users,
      ...teamMembers.map((m) => m.user),
      ...site.boardAccesses.map((a) => a.user),
    ].filter((u) => {
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });

    res.json(all);
  } catch (error) {
    captureError('Error fetching users for site:', error);
    res.status(500).json({ error: 'Unable to fetch users for site' });
  }
});

app.patch('/api/site/:slug/archive', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { archived } = req.body;
  const userId = req.user.id;

  if (typeof archived !== 'boolean') {
    return res.status(400).json({ error: '`archived` must be a boolean' });
  }

  try {
    const result = await prisma.qAReport.updateMany({
      where: { slug, userId },
      data: {
        archived,
        archivedAt: archived ? new Date() : null,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({
      message: `${result.count} report(s) ${
        archived ? 'archived' : 'unarchived'
      } for site "${slug}"`,
    });
  } catch (error) {
    captureError('Failed to archive reports:', error);
    res.status(500).json({ error: 'Failed to archive/unarchive reports' });
  }
});

// DELETE /api/site/:slug — permanently delete a site and all its reports
app.delete('/api/site/:slug', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const userId = req.user.id;

  try {
    // Only the team owner (or the user who owns the reports) may delete
    const site = await prisma.site.findFirst({
      where: { OR: [{ slug }, { domain: slug }] },
      select: { id: true, slug: true, teamId: true },
    });

    if (!site) return res.status(404).json({ error: 'Site not found' });

    // M4 — live DB membership check instead of stale JWT team data
    if (site.teamId) {
      const isMember = await prisma.teamMember.findFirst({ where: { teamId: site.teamId, userId: req.user.id } });
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Run deletions sequentially outside a long-lived transaction to avoid
    // FK RESTRICT conflicts (SiteUser) and implicit join-table issues (_SiteMembers).
    // Each step is idempotent so partial failures leave the DB in a safe state.

    // 1. Disconnect users from the site's implicit many-to-many (_SiteMembers)
    await prisma.site.update({
      where: { id: site.id },
      data: { users: { set: [] } },
    });

    // 2. SiteUser (RESTRICT FK — must go before site delete)
    await prisma.siteUser.deleteMany({ where: { siteId: site.id } });

    // 3. QAReport → Comment (CASCADE) → Attachment (CASCADE)
    await prisma.qAReport.deleteMany({ where: { siteId: site.id } });

    // 4. Site — KanbanColumn, BoardAccess, BoardInvite, Notification all CASCADE or SET NULL
    await prisma.site.delete({ where: { id: site.id } });

    invalidateUserStats(userId);
    invalidateUserSites(userId);
    res.json({ message: 'Site deleted successfully' });
  } catch (error) {
    captureError('Error deleting site:', error);
    res.status(500).json({ error: 'Failed to delete site' }); // H6 — removed internal detail
  }
});

// GET /api/site/:slug/columns — return custom kanban columns for a site
app.get('/api/site/:slug/columns', authenticateToken, cacheMiddleware((req) => `columns:${req.params.slug}`, TTL.COLUMNS), async (req, res) => {
  const { slug } = req.params;
  const { teamId } = req.query;

  try {
    const site = await resolveSiteForUser(slug, teamId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const columns = await prisma.kanbanColumn.findMany({
      where: { siteId: site.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });

    res.json(columns.map((col) => ({ ...col, slug })));
  } catch (error) {
    captureError('Failed to fetch columns:', error);
    res.status(500).json({ error: 'Failed to fetch columns' });
  }
});

// POST /api/site/:slug/columns — create a custom kanban column
app.post('/api/site/:slug/columns', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { name, teamId } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!teamId) {
    return res.status(400).json({ error: 'teamId is required' });
  }

  try {
    const site = await resolveSiteForUser(slug, teamId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const column = await prisma.kanbanColumn.create({
      data: { name: name.trim(), siteId: site.id },
      select: { id: true, name: true },
    });

    io.to(`site:${slug}`).emit('board:event', { type: 'column:created', column: { ...column, slug } });
    invalidateSiteColumns(slug);
    res.status(201).json({ ...column, slug });
  } catch (error) {
    captureError('Failed to create column:', error);
    res.status(500).json({ error: 'Failed to create column' });
  }
});

// DELETE /api/site/:slug/columns/:columnId — delete a custom kanban column (only if empty)
app.delete('/api/site/:slug/columns/:columnId', authenticateToken, async (req, res) => {
  const { slug, columnId } = req.params;
  const { teamId } = req.query;

  if (!teamId) {
    return res.status(400).json({ error: 'teamId is required' });
  }

  try {
    const site = await resolveSiteForUser(slug, teamId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const column = await prisma.kanbanColumn.findFirst({
      where: { id: columnId, siteId: site.id },
    });
    if (!column) return res.status(404).json({ error: 'Column not found' });

    const reportCount = await prisma.qAReport.count({
      where: { siteId: site.id, status: column.name },
    });

    if (reportCount > 0) {
      return res.status(409).json({ error: 'Column still has reports' });
    }

    await prisma.kanbanColumn.delete({ where: { id: columnId } });

    io.to(`site:${slug}`).emit('board:event', { type: 'column:deleted', columnId });
    invalidateSiteColumns(slug);
    res.json({ message: 'Column deleted' });
  } catch (error) {
    captureError('Failed to delete column:', error);
    res.status(500).json({ error: 'Failed to delete column' });
  }
});

// GET /api/site/:slug/columns/order — return saved column order for a site
app.get('/api/site/:slug/columns/order', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { teamId } = req.query;

  try {
    const site = await resolveSiteForUser(slug, teamId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    res.json({ order: site.columnOrder });
  } catch (error) {
    captureError('Failed to fetch column order:', error);
    res.status(500).json({ error: 'Failed to fetch column order' });
  }
});

// PATCH /api/site/:slug/columns/reorder — persist column order
app.patch('/api/site/:slug/columns/reorder', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { order, teamId } = req.body;

  if (!teamId) {
    return res.status(400).json({ error: 'teamId is required' });
  }
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array' });
  }

  try {
    const site = await resolveSiteForUser(slug, teamId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    await prisma.site.update({
      where: { id: site.id },
      data: { columnOrder: order },
    });

    io.to(`site:${slug}`).emit('board:event', { type: 'column:reordered', order });
    invalidateSiteColumns(slug);
    res.json({ order });
  } catch (error) {
    captureError('Failed to save column order:', error);
    res.status(500).json({ error: 'Failed to save column order' });
  }
});


app.patch('/api/report/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ error: 'Status is required' });

  try {
    const existing = await assertReportAccess(id, req.user.id, res);
    if (!existing) return;

    const updates = { status };

    // If changing to "resolved", calculate and store resolution data
    if (status === 'done') {
      const resolvedAt = new Date();
      const duration = Math.round(
        (resolvedAt.getTime() - new Date(existing.timestamp).getTime()) / 60000,
      ); // minutes
      updates.resolvedAt = resolvedAt;
      updates.duration = duration;
    }

    const updatedReport = await prisma.qAReport.update({
      where: { id },
      data: updates,
    });

    invalidateUserStats(req.user.id);
    res.json(updatedReport);
  } catch (error) {
    captureError('Error updating report:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

app.get('/api/stats/open-issues', authenticateToken, cacheMiddleware((req) => `stats:open:${req.user.id}:${req.query.teamId || ''}`, TTL.STATS), async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;

  try {
    const siteDomains = await getTeamSiteDomains(userId, teamId);
    const openCount = await prisma.qAReport.count({
      where: {
        status: 'new',
        site: { in: siteDomains },
        archived: false,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });
    res.json({ openIssues: openCount });
  } catch (error) {
    captureError('Error fetching open issues:', error);
    res.status(500).json({ error: 'Failed to fetch open issues count' });
  }
});

app.get('/api/stats/in-progress', authenticateToken, cacheMiddleware((req) => `stats:inprogress:${req.user.id}:${req.query.teamId || ''}`, TTL.STATS), async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;
  try {
    const siteDomains = await getTeamSiteDomains(userId, teamId);
    const inProgressCount = await prisma.qAReport.count({
      where: {
        status: 'inProgress',
        site: { in: siteDomains },
        archived: false,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });
    res.json({ inProgressIssues: inProgressCount });
  } catch (error) {
    captureError('Error fetching open issues:', error);
    res.status(500).json({ error: 'Failed to fetch open issues count' });
  }
});

app.get('/api/stats/resolved', authenticateToken, cacheMiddleware((req) => `stats:resolved:${req.user.id}:${req.query.teamId || ''}`, TTL.STATS), async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;
  try {
    const siteDomains = await getTeamSiteDomains(userId, teamId);
    const resolvedCount = await prisma.qAReport.count({
      where: {
        status: 'done',
        site: { in: siteDomains },
        archived: false,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });
    res.json({ resolvedIssues: resolvedCount });
  } catch (error) {
    captureError('Error fetching open issues:', error);
    res.status(500).json({ error: 'Failed to fetch open issues count' });
  }
});

const ISSUE_SUMMARY_CUSTOM_COLORS = ['#a855f7', '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16'];

app.get('/api/stats/issues-summary', authenticateToken, cacheMiddleware((req) => `stats:summary:${req.user.id}:${req.query.teamId || ''}`, TTL.STATS), async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;

  try {
    const siteDomains = await getTeamSiteDomains(userId, teamId);

    // Group by status so custom columns (status = a KanbanColumn id) aren't silently dropped
    const [grouped, sites] = await Promise.all([
      prisma.qAReport.groupBy({
        by: ['status'],
        where: { site: { in: siteDomains }, archived: false },
        _count: { status: true },
      }),
      prisma.site.findMany({ where: { domain: { in: siteDomains } }, select: { id: true } }),
    ]);

    const siteIds = sites.map((s) => s.id);
    const customColumns = siteIds.length
      ? await prisma.kanbanColumn.findMany({
          where: { siteId: { in: siteIds } },
          select: { id: true, name: true },
        })
      : [];
    const columnNameById = new Map(customColumns.map((c) => [c.id, c.name]));

    const countByStatus = new Map(grouped.map((g) => [g.status, g._count.status]));
    const openCount = countByStatus.get('new') || 0;
    const inProgressCount = countByStatus.get('inProgress') || 0;
    const doneCount = countByStatus.get('done') || 0;

    // Anything left over is either a known custom column or an orphaned/deleted one
    const customEntries = [];
    let colorIndex = 0;
    for (const [status, count] of countByStatus) {
      if (status === 'new' || status === 'inProgress' || status === 'done') continue;
      const name = columnNameById.get(status) || 'Other';
      const existing = customEntries.find((e) => e.name === name);
      if (existing) {
        existing.value += count;
      } else {
        customEntries.push({ name, value: count, color: ISSUE_SUMMARY_CUSTOM_COLORS[colorIndex % ISSUE_SUMMARY_CUSTOM_COLORS.length] });
        colorIndex++;
      }
    }

    const counts = [
      { name: 'Open', value: openCount, color: '#60A5FA' },
      { name: 'In Progress', value: inProgressCount, color: '#FBBF24' },
      { name: 'Done', value: doneCount, color: '#34D399' },
      ...customEntries,
    ];

    const total = counts.reduce((sum, c) => sum + c.value, 0) || 1; // prevent division by zero

    // round to 1 decimal, then nudge the largest bucket so percentages sum to exactly 100
    let pcts = counts.map((c) => Math.round(((c.value / total) * 100) * 10) / 10);
    const diff = 100 - pcts.reduce((s, p) => s + p, 0);
    if (diff !== 0) {
      const maxIdx = pcts.indexOf(Math.max(...pcts));
      pcts[maxIdx] = Math.round((pcts[maxIdx] + diff) * 10) / 10;
    }

    const issuesSummary = counts.map((c, i) => ({ ...c, percentage: pcts[i] }));

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(issuesSummary);
  } catch (error) {
    captureError('Error fetching issues summary:', error);
    res.status(500).json({ error: 'Failed to fetch issues summary' });
  }
});

// GET /api/stats/reports-this-week
app.get('/api/stats/reports-this-week', authenticateToken, cacheMiddleware((req) => `stats:weekly:${req.user.id}:${req.query.teamId || ''}`, TTL.STATS), async (req, res) => {
  const userId = req.user.id;
  const { teamId } = req.query;
  try {
    const siteDomains = await getTeamSiteDomains(userId, teamId);
    const startOfWeek = new Date();
    startOfWeek.setUTCHours(0, 0, 0, 0);
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay()); // Sunday

    const count = await prisma.qAReport.count({
      where: {
        site: { in: siteDomains },
        archived: false,
        timestamp: {
          gte: startOfWeek,
        },
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({ reportsThisWeek: count });
  } catch (error) {
    captureError('Error fetching weekly report count:', error);
    res.status(500).json({ error: 'Failed to fetch reports this week' });
  }
});

// GET /api/stats/avg-resolution-time
app.get(
  '/api/stats/avg-resolution-time',
  authenticateToken,
  cacheMiddleware((req) => `stats:avgresolution:${req.user.id}:${req.query.teamId || ''}`, TTL.STATS),
  async (req, res) => {
    const userId = req.user.id;
    const { teamId } = req.query;
    try {
      const siteDomains = await getTeamSiteDomains(userId, teamId);
      const reports = await prisma.qAReport.findMany({
        where: {
          site: { in: siteDomains },
          status: 'resolved',
          archived: false,
          resolvedAt: {
            not: null,
          },
        },
        select: {
          timestamp: true,
          resolvedAt: true,
        },
      });

      const durations = reports.map((report) => {
        return (
          new Date(report.resolvedAt).getTime() -
          new Date(report.timestamp).getTime()
        );
      });

      const avgMs =
        durations.reduce((sum, d) => sum + d, 0) / (durations.length || 1);
      const avgHours = (avgMs / (1000 * 60 * 60)).toFixed(2);

      await prisma.user.update({
        where: { id: req.user.id },
        data: { lastActive: new Date() },
      });

      res.json({ avgResolutionTimeHours: avgHours });
    } catch (error) {
      captureError('Error calculating avg resolution time:', error);
      res
        .status(500)
        .json({ error: 'Failed to calculate average resolution time' });
    }
  },
);

// PATCH /api/report/:id/description — update the report description/comment
app.patch('/api/report/:id/description', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  if (comment === undefined) return res.status(400).json({ error: 'comment is required' });
  try {
    const access = await assertReportAccess(id, req.user.id, res);
    if (!access) return;
    const updated = await prisma.qAReport.update({
      where: { id },
      data: { comment },
      include: { Site: { select: { slug: true } } },
    });
    if (updated.Site?.slug) {
      io.to(`site:${updated.Site.slug}`).emit('board:event', {
        type: 'report:updated',
        reportId: id,
        comment,
      });
    }
    res.json({ comment: updated.comment });
  } catch (error) {
    captureError('Failed to update description:', error);
    res.status(500).json({ error: 'Failed to update description' });
  }
});

// PATCH /api/report/:id/due-date
app.patch('/api/report/:id/due-date', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { dueDate } = req.body;

  // Allow clearing the due date by sending null
  if (dueDate !== null && isNaN(Date.parse(dueDate))) {
    return res.status(400).json({
      error: 'dueDate must be a valid ISO date string or null',
    });
  }

  try {
    const existing = await assertReportAccess(id, req.user.id, res);
    if (!existing) return;

    const updatedReport = await prisma.qAReport.update({
      where: { id },
      data: {
        dueDate: dueDate ? new Date(dueDate) : null,
      },
    });

    // 🔔 Log activity if someone else updated it
    if (updatedReport.userId && updatedReport.userId !== req.user.id) {
      await logActivity({
        userId: updatedReport.userId, // task owner
        actorId: req.user.id, // who changed it
        type: 'due_date',
        reportId: id,
        message: dueDate
          ? `set due date to ${new Date(dueDate).toLocaleDateString()}`
          : 'cleared the due date',
        dueDate: dueDate ? new Date(dueDate) : null,
      });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(updatedReport);
  } catch (error) {
    captureError('Failed to update due date:', error);
    res.status(500).json({ error: 'Failed to update due date' });
  }
});

// PATCH /api/report/:id/status
app.patch('/api/report/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const access = await assertReportAccess(id, req.user.id, res);
    if (!access) return;
    const updated = await prisma.qAReport.update({
      where: { id },
      data: { status },
      include: { Site: { select: { slug: true } } },
    });

    if (updated.userId !== req.user.id) {
      await logActivity({
        userId: updated.userId, // task owner
        actorId: req.user.id, // the user who changed the status
        type: 'status',
        reportId: id,
        message: `${req.user.name} moved your task to "${status}"`,
        status,
      });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    if (updated.Site?.slug) {
      io.to(`site:${updated.Site.slug}`).emit('board:event', { type: 'report:status', reportId: id, status });
    }

    res.json(updated);
  } catch (error) {
    captureError('Failed to update status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// GET /api/report/:id/status
app.get('/api/report/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // M2 — ownership check
    const access = await assertReportAccess(id, req.user.id, res);
    if (!access) return;

    const report = await prisma.qAReport.findUnique({
      where: { id },
      select: { status: true }, // Only fetch the 'status' field
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json(report); // will return { status: "some_status" }
  } catch (error) {
    captureError('Failed to get status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// PATCH /api/report/:id/assignee — reassign a task to another team/board member
app.patch('/api/report/:id/assignee', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { userId, userName } = req.body;

  if (!userId || !userName) {
    return res.status(400).json({ error: 'userId and userName are required' });
  }

  try {
    const access = await assertReportAccess(id, req.user.id, res);
    if (!access) return;

    // Verify the target assignee is a member of the same team as the report
    const siteTeamId = access.Site?.teamId;
    if (siteTeamId) {
      const targetMember = await prisma.teamMember.findFirst({
        where: { teamId: siteTeamId, userId },
      });
      if (!targetMember) {
        return res.status(403).json({ error: 'Assignee is not a member of this team' });
      }
    }

    const updated = await prisma.qAReport.update({
      where: { id },
      data: { userId, userName },
      include: { Site: { select: { slug: true } } },
    });

    // Notify the newly assigned user (if it's not the person doing the reassigning)
    if (userId !== req.user.id) {
      await logActivity({
        userId,                  // the new assignee
        actorId: req.user.id,
        type: 'assignment',
        reportId: id,
        message: `${req.user.name} assigned you a task`,
      });

      const assignee = await prisma.user.findUnique({
        where: { id: userId },
        select: { notificationPrefs: true },
      });
      const prefs = assignee?.notificationPrefs;
      if (!prefs || prefs.taskAssigned !== false) {
        await prisma.notification.create({
          data: {
            userId,
            type: 'TASK_ASSIGNED',
            message: `${req.user.name} assigned you "${updated.title}"`,
            reportId: id,
          },
        });
      }
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    if (updated.Site?.slug) {
      io.to(`site:${updated.Site.slug}`).emit('board:event', {
        type: 'report:assignee',
        reportId: id,
        userId,
        userName,
      });
    }

    res.json({ userId: updated.userId, userName: updated.userName });
  } catch (error) {
    captureError('Failed to update assignee:', error);
    res.status(500).json({ error: 'Failed to update assignee' });
  }
});

app.patch('/api/report/:id/priority', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { priority } = req.body;

  const allowed = ['not assigned', 'low', 'medium', 'high', 'urgent'];

  if (!priority || !allowed.includes(priority)) {
    return res.status(400).json({
      error: `Priority must be one of: ${allowed.join(', ')}`,
    });
  }

  try {
    const existing = await assertReportAccess(id, req.user.id, res);
    if (!existing) return;

    const updatedReport = await prisma.qAReport.update({
      where: { id },
      data: { priority },
    });

    // Log activity (if you want)
    if (updatedReport.userId !== req.user.id) {
      await logActivity({
        userId: updatedReport.userId, // task owner
        actorId: req.user.id, // the user who changed the status
        type: 'priority',
        reportId: id,
        message: `changed priority to ${priority}`,
        priority,
      });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    // Notify all clients on this board so priority changes are reflected live
    if (updatedReport.siteId) {
      const site = await prisma.site.findUnique({ where: { id: updatedReport.siteId }, select: { slug: true } });
      if (site?.slug) {
        io.to(`site:${site.slug}`).emit('board:event', { type: 'report:updated', reportId: id, priority });
      }
    }

    res.json(updatedReport);
  } catch (error) {
    captureError('Error updating priority:', error);
    res.status(500).json({ error: 'Failed to update priority' });
  }
});

// PATCH /api/report/:id/type
app.patch('/api/report/:id/type', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { type } = req.body;

  const allowed = ['bug', 'suggestion', 'task'];
  if (!type || !allowed.includes(type)) {
    return res.status(400).json({ error: `Type must be one of: ${allowed.join(', ')}` });
  }

  try {
    const existing = await assertReportAccess(id, req.user.id, res);
    if (!existing) return;

    const updatedReport = await prisma.qAReport.update({ where: { id }, data: { type } });

    await prisma.user.update({ where: { id: req.user.id }, data: { lastActive: new Date() } });

    res.json(updatedReport);
  } catch (error) {
    captureError('Error updating type:', error);
    res.status(500).json({ error: 'Failed to update type' });
  }
});

// GET /api/report/:id/priority
app.get('/api/report/:id/priority', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // M2 — ownership check
    const access = await assertReportAccess(id, req.user.id, res);
    if (!access) return;

    const report = await prisma.qAReport.findUnique({
      where: { id },
      select: { priority: true }, // Only fetch the 'priority' field
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json(report);
  } catch (error) {
    captureError('Failed to get priority:', error);
    res.status(500).json({ error: 'Failed to get priority' });
  }
});

// Create a new comment with attachments for a report
app.post(
  '/api/reports/:reportId/comments',
  authenticateToken,
  uploadAttachments.array('attachments', 10),
  async (req, res) => {
    const { reportId } = req.params;
    const { content, parentId, mentionedUserIds: rawMentionedIds } = req.body;
    // mentionedUserIds may come as a single string or array from FormData
    const explicitMentions = rawMentionedIds
      ? Array.isArray(rawMentionedIds) ? rawMentionedIds : [rawMentionedIds]
      : [];
    const attachments = req.files;

    if (!reportId || !content) {
      return res.status(400).json({ error: 'reportId and content are required' });
    }
    if (content.length > 5000) {
      return res.status(400).json({ error: 'Comment must be 5000 characters or fewer' });
    }

    const access = await assertReportAccess(reportId, req.user.id, res);
    if (!access) return;

    try {
      const uploadedAttachments = attachments?.length
        ? await Promise.all(
            attachments.map(async (file) => {
              const sanitisedAttachName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'); // M5
              const fileKey = `comments/${Date.now()}_${sanitisedAttachName}`;

              // upload original
              await uploadBufferToR2(file.buffer, fileKey, file.mimetype);
              let thumbnailKey = null;

              // generate thumbnail for images
              if (file.mimetype.startsWith('image/')) {
                const thumbBuffer = await generateThumbnail(file.buffer);
                thumbnailKey = `comments/thumbnails/thumb_${fileKey}`;

                await uploadBufferToR2(thumbBuffer, thumbnailKey, 'image/webp');
              }

              return {
                key: fileKey,
                thumbnailKey,
                name: file.originalname,
                size: file.size,
                type: file.mimetype,
              };
            }),
          )
        : [];

      const data = {
        content,
        reportId,
        parentId: parentId || null,
        userId: req.user.id,
        attachments:
          uploadedAttachments && uploadedAttachments.length > 0
            ? { create: uploadedAttachments }
            : undefined,
      };

      // Add userId only if provided
      // if (userId) {
      //   data.userId = userId;
      // }

      const comment = await prisma.comment.create({
        data,
        include: {
          attachments: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      // Notify all mentioned users (explicit list sent from client)
      const toNotify = [...new Set(explicitMentions)].filter((uid) => uid !== req.user.id);
      if (toNotify.length > 0) {
        await Promise.all(
          toNotify.map((mentionedUserId) =>
            prisma.notification.create({
              data: {
                userId: mentionedUserId,
                type: 'MENTION',
                commentId: comment.id,
                reportId: comment.reportId,
                message: `${req.user.name} mentioned you in a comment`,
              },
            })
          )
        );
      }

      await prisma.user.update({
        where: { id: req.user.id },
        data: { lastActive: new Date() },
      });

      res.json(comment);
    } catch (error) {
      captureError(error);
      res
        .status(500)
        .json({ error: 'Unable to create comment with attachments' });
    }
  },
);

// Retrieve comments with attachments for a report
app.get('/api/reports/:reportId/comments', authenticateToken, async (req, res) => {
  const { reportId } = req.params;

  const access = await assertReportAccess(reportId, req.user.id, res);
  if (!access) return;

  try {
    const comments = await prisma.comment.findMany({
      where: { reportId, parentId: null },
      orderBy: { createdAt: 'desc' },
      include: {
        attachments: true,
        user: {
          select: { id: true, name: true, email: true },
        },
        replies: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachments: true,
            user: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    const withSignedUrls = await Promise.all(
      comments.map(async (comment) => ({
        ...comment,
        attachments: await Promise.all(
          comment.attachments.map(async (a) => ({
            ...a,
            signedUrl: await getSignedR2Url(a.key),
            thumbnailUrl: a.thumbnailKey
              ? await getSignedR2Url(a.thumbnailKey)
              : null,
          })),
        ),
      })),
    );

    res.json(withSignedUrls);
  } catch (error) {
    captureError(error);
    res.status(500).json({ error: 'Unable to fetch comments' });
  }
});

app.delete('/api/report/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  // C1 — ownership check before deletion
  const access = await assertReportAccess(id, req.user.id, res);
  if (!access) return;

  try {
    let deletedSiteSlug = null;

    await prisma.$transaction(async (tx) => {
      // Get report incl. site id + R2 keys for cleanup
      const report = await tx.qAReport.findUnique({
        where: { id },
        select: { id: true, siteId: true, imagePath: true, videoPath: true, Site: { select: { slug: true } } },
      });

      if (!report) {
        throw new Error('REPORT_NOT_FOUND');
      }

      const { siteId, imagePath, videoPath } = report;
      deletedSiteSlug = report.Site?.slug ?? null;

      // ---- R2 CLEANUP ----
      const r2Keys = [imagePath, videoPath].filter(Boolean);
      if (r2Keys.length) {
        await deleteObjectsFromR2(r2Keys).catch((err) =>
          captureError('R2 cleanup on report delete failed:', err)
        );
      }

      // ---- DELETE REPORT ----
      await tx.qAReport.delete({ where: { id } });

      // ---- CHECK IF SITE IS NOW EMPTY ----
      if (siteId) {
        const remaining = await tx.qAReport.count({
          where: { siteId },
        });

        if (remaining === 0) {
          await tx.site.delete({ where: { id: siteId } });
        }
      }
    });

    if (deletedSiteSlug) {
      io.to(`site:${deletedSiteSlug}`).emit('board:event', { type: 'report:deleted', reportId: id });
    }

    invalidateUserStats(req.user.id);
    invalidateUserSites(req.user.id);
    res.json({ message: 'Report deleted successfully' });
  } catch (error) {
    if (error instanceof Error && error.message === 'REPORT_NOT_FOUND') {
      return res.status(404).json({ error: 'Report not found' });
    }

    captureError('Error deleting report:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// Returns canonical plan limits — frontend uses this as single source of truth
app.get('/api/plan-limits', authenticateToken, (req, res) => {
  // Replace Infinity with null so JSON serialisation works
  const serialisable = Object.fromEntries(
    Object.entries(PLAN_LIMITS).map(([plan, limits]) => [
      plan,
      Object.fromEntries(
        Object.entries(limits).map(([k, v]) => [k, v === Infinity ? null : v])
      ),
    ])
  );
  res.json(serialisable);
});

app.get('/api/team/:teamId/stats', authenticateToken, async (req, res) => {
  try {
    const { teamId } = req.params;

    // Verify the user belongs to the team
    const isMember = await prisma.teamMember.findFirst({
      where: { teamId, userId: req.user.id },
    });

    if (!isMember) {
      return res
        .status(403)
        .json({ error: 'You are not a member of this team.' });
    }

    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Fetch team counts + this month’s screenshot count in parallel
    const [teamStats, screenshotsCount] = await Promise.all([
      prisma.team.findUnique({
        where: { id: teamId },
        select: {
          id: true,
          _count: { select: { members: true, sites: true } },
        },
      }),
      prisma.qAReport.count({
        where: {
          site: { teamId },
          createdAt: { gte: startOfMonth },
        },
      }),
    ]);

    if (!teamStats) {
      return res.status(404).json({ error: "Team not found" });
    }

    return res.json({
      teamId: teamStats.id,
      screenshotsCount,
      projectsCount: teamStats._count.sites,
      teamMembersCount: teamStats._count.members,
    });
  } catch (err) {
    captureError(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/teams', authenticateToken, async (req, res) => {
  try {
    const teams = await prisma.team.findMany({
      where: {
        members: {
          some: { userId: req.user.id },
        },
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(teams);
  } catch (error) {
    captureError('Failed to get teams:', error);
    res.status(500).json({ error: 'Failed to get teams' });
  }
});

app.post('/billing/checkout', authenticateToken, async (req, res) => {
  try {
  const { teamId, priceId } = req.body;

  // L1 — validate priceId against known env-var price IDs (allow null/undefined for free downgrade)
  const allowedPriceIds = [
    process.env.PRICE_FREE_MONTHLY,
    process.env.PRICE_FREE_YEARLY,
    process.env.PRICE_STARTER_MONTHLY,
    process.env.PRICE_STARTER_YEARLY,
    process.env.PRICE_TEAM_MONTHLY,
    process.env.PRICE_TEAM_YEARLY,
  ].filter(Boolean);
  if (priceId && !allowedPriceIds.includes(priceId)) {
    return res.status(400).json({ error: 'Invalid price' });
  }

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { subscription: true },
  });

  // Ensure only owner can upgrade
  const isOwner = await prisma.teamMember.findFirst({
    where: { teamId, userId: req.user.id, role: 'owner' },
  });

  if (!isOwner)
    return res.status(403).json({ error: 'Only team owners can upgrade' });

  const targetPlan = mapPriceToPlan(priceId);

  // ⭐ DOWNGRADE TO FREE → cancel the active subscription immediately
  if (targetPlan === 'free') {
    if (team.subscription?.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.cancel(team.subscription.stripeSubscriptionId);
      } catch (err) {
        if (err?.code !== 'resource_missing') throw err;
      }
    }
    await prisma.subscription.update({
      where: { teamId },
      data: { plan: 'free', status: 'canceled', stripeSubscriptionId: null, stripePriceId: null },
    });
    await prisma.team.update({ where: { id: teamId }, data: { plan: 'free' } });
    return res.json({ status: 'updated' });
  }

  // Create customer if missing
  let customerId = team.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: req.user.email,
      metadata: { teamId },
    });

    customerId = customer.id;

    await prisma.team.update({
      where: { id: teamId },
      data: { stripeCustomerId: customerId },
    });
  }

  const plan = targetPlan;

  // ⭐ EXISTING SUBSCRIPTION → UPDATE PLAN IN STRIPE (NO NEW SUB)
  if (team.subscription?.stripeSubscriptionId) {
    let stripeSub = null;
    try {
      // Retrieve the live subscription to get the subscription item ID (si_...)
      stripeSub = await stripe.subscriptions.retrieve(team.subscription.stripeSubscriptionId);
    } catch (err) {
      if (err?.code === 'resource_missing') {
        // Stale subscription ID in DB — clear it and fall through to checkout
        await prisma.subscription.update({
          where: { teamId },
          data: { stripeSubscriptionId: null, stripePriceId: null, status: 'canceled' },
        });
      } else {
        throw err;
      }
    }

    if (stripeSub) {
      const itemId = stripeSub.items.data[0]?.id;
      if (!itemId) return res.status(400).json({ error: 'No subscription item found' });

      await stripe.subscriptions.update(team.subscription.stripeSubscriptionId, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'create_prorations',
      });

      await prisma.subscription.update({
        where: { teamId },
        data: { plan, stripePriceId: priceId },
      });

      await prisma.team.update({ where: { id: teamId }, data: { plan } });

      return res.json({ status: 'updated' });
    }
    // stripeSub was null (stale ID cleared) → fall through to checkout below
  }

  // ⭐ NO SUBSCRIPTION → CREATE VIA CHECKOUT
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/usage-billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/usage-billing`,
    subscription_data: {
      metadata: { teamId },
    },
    metadata: { teamId },
  });

  res.json({ url: session.url });
  } catch (err) {
    captureError('Billing checkout error:', err);
    res.status(500).json({ error: err?.message ?? 'Checkout failed' });
  }
});

// GET /billing/verify-session?sessionId=cs_... — confirm checkout and write plan to DB
// Used as a fallback for local dev where webhooks can't reach localhost.
app.get('/billing/verify-session', authenticateToken, async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'subscription.items.data.price'],
    });

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const sub = session.subscription;
    if (!sub) return res.status(400).json({ error: 'No subscription on session' });

    const teamId = session.metadata?.teamId;
    if (!teamId) return res.status(400).json({ error: 'No teamId in session metadata' });

    // L2 — verify caller is an owner of the team in the session metadata
    const isOwner = await prisma.teamMember.findFirst({ where: { teamId, userId: req.user.id, role: 'owner' } });
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    const priceId = sub.items.data[0].price.id;
    const plan = mapPriceToPlan(priceId);

    await prisma.subscription.upsert({
      where: { teamId },
      update: {
        plan,
        interval: sub.items.data[0].price.recurring.interval,
        status: sub.status,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
        stripeSubscriptionId: sub.id,
        stripePriceId: priceId,
        currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
        teamId,
      },
      create: {
        teamId,
        plan,
        interval: sub.items.data[0].price.recurring.interval,
        status: sub.status,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
        stripeSubscriptionId: sub.id,
        stripePriceId: priceId,
        currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      },
    });

    await prisma.team.update({ where: { id: teamId }, data: { plan } });

    res.json({ plan });
  } catch (err) {
    captureError('verify-session error:', err);
    res.status(500).json({ error: err?.message ?? 'Verification failed' });
  }
});

// GET /api/search?q=keyword
app.get('/api/search', authenticateToken, searchLimiter, cacheMiddleware((req) => `search:${req.user.id}:${req.query.q}`, TTL.SEARCH), async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1)
    return res.json({ projects: [], issues: [], users: [] });

  const keyword = q.toString().toLowerCase();

  try {
    // Search Projects (Sites)
    const projects = await prisma.site.findMany({
      where: {
        name: { contains: keyword, mode: 'insensitive' },
        users: { some: { id: req.user.id } },
      },
      select: { id: true, name: true, slug: true },
      take: 10,
      distinct: ['id'],
    });

    // Search Issues (QA Reports)
    const issues = await prisma.qAReport.findMany({
      where: {
        OR: [
          { comment: { contains: keyword, mode: 'insensitive' } },
          { siteName: { contains: keyword, mode: 'insensitive' } },
        ],
        userId: req.user.id,
        archived: false,
      },
      select: { id: true, comment: true, siteName: true, status: true },
      take: 10,
    });

    // Search Users — M3: scope to members of teams the authenticated user belongs to
    const memberships = await prisma.teamMember.findMany({ where: { userId: req.user.id }, select: { teamId: true } });
    const teamIds = memberships.map((m) => m.teamId);
    const teamUserIds = await prisma.teamMember.findMany({ where: { teamId: { in: teamIds } }, select: { userId: true } });
    const scopedIds = [...new Set(teamUserIds.map((m) => m.userId))];
    const users = await prisma.user.findMany({
      where: {
        id: { in: scopedIds },
        OR: [
          { name: { contains: keyword, mode: 'insensitive' } },
          { email: { contains: keyword, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, email: true },
      take: 10,
    });

    res.json({ projects, issues, users });
  } catch (error) {
    captureError('Search error:', error);
    res.status(500).json({ error: 'Failed to perform search' });
  }
});

app.get('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const teamMember = await prisma.teamMember.findFirst({
      where: { userId: req.user.id },
      include: { team: true },
    });

    if (!teamMember?.team?.stripeCustomerId) {
      return res.json([]); // no Stripe customer yet — return empty list
    }

    const customerId = teamMember.team.stripeCustomerId;

    const invoices = await stripe.invoices.list({ customer: customerId, limit: 20 });

    const formattedInvoices = invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      amount_due: inv.amount_due,
      status: inv.status,
      created: inv.created,
      invoice_pdf: inv.invoice_pdf,
      subscription: inv.subscription,
    }));

    res.json(formattedInvoices);
  } catch (error) {
    captureError('Error fetching invoices:', error);
    // Customer not found in Stripe (test/live mode mismatch) — return empty list
    if (error?.type === 'StripeInvalidRequestError') {
      return res.json([]);
    }
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

app.get('/billing/next-renewal/:subscriptionId', authenticateToken, async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    // Read from DB — currentPeriodEnd is synced via webhook on every renewal
    const dbSub = await prisma.subscription.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
      select: { currentPeriodEnd: true, interval: true, createdAt: true, teamId: true },
    });

    if (!dbSub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Verify the authenticated user is a member of the team owning this subscription
    if (dbSub.teamId) {
      const membership = await prisma.teamMember.findFirst({
        where: { teamId: dbSub.teamId, userId: req.user.id },
      });
      if (!membership) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    let nextDate;

    if (dbSub.currentPeriodEnd) {
      // Best case: webhook has kept this up to date
      nextDate = new Date(dbSub.currentPeriodEnd);
    } else {
      // currentPeriodEnd not in DB — try Stripe first, then calculate locally
      try {
        const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
        if (stripeSub.current_period_end) {
          nextDate = new Date(stripeSub.current_period_end * 1000);
          // Backfill so future requests skip Stripe
          await prisma.subscription.updateMany({
            where: { stripeSubscriptionId: subscriptionId },
            data: { currentPeriodEnd: nextDate },
          });
        }
      } catch {
        // Stripe unavailable or sub not found there — fall through to local calculation
      }

      if (!nextDate) {
        // Calculate from billing cycle anchor (createdAt) + interval
        const anchor = new Date(dbSub.createdAt);
        const interval = dbSub.interval || 'month';
        const now = new Date();

        // Advance anchor by full billing periods until we're in the future
        nextDate = new Date(anchor);
        while (nextDate <= now) {
          if (interval === 'year') {
            nextDate.setFullYear(nextDate.getFullYear() + 1);
          } else {
            nextDate.setMonth(nextDate.getMonth() + 1);
          }
        }
      }
    }

    const nextUnix = Math.floor(nextDate.getTime() / 1000);
    const formattedDate = nextDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return res.json({
      subscriptionId,
      nextBillingDateFormatted: formattedDate,
      nextBillingDateUnix: nextUnix,
    });
  } catch (err) {
    captureError('next-renewal error:', err);
    res.status(500).json({ error: 'Failed to get next billing date' });
  }
});

// POST /billing/portal — create a Stripe Customer Portal session
app.post('/billing/portal', authenticateToken, async (req, res) => {
  try {
    const { returnUrl } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { teams: { include: { team: { include: { subscription: true } } } } },
    });

    const sub = user?.teams?.[0]?.team?.subscription;
    if (!sub?.stripeCustomerId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: returnUrl || process.env.APP_URL + '/usage-billing',
    });

    res.json({ url: session.url });
  } catch (error) {
    captureError('Failed to create billing portal session:', error);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// POST /billing/cancel-subscription
app.post('/billing/cancel-subscription', authenticateToken, async (req, res) => {
  try {
    const { teamId } = req.body;
    if (!teamId) return res.status(400).json({ error: 'teamId is required' });

    // Only the team owner may cancel billing for the team
    const teamMember = await prisma.teamMember.findFirst({
      where: { teamId, userId: req.user.id, role: 'owner' },
      include: { team: { include: { subscription: true } } },
    });
    if (!teamMember) return res.status(403).json({ error: 'Only team owners can cancel the subscription' });

    const team = teamMember?.team;
    const sub  = team?.subscription;

    if (!sub?.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }
    if (sub.status === 'canceled' || sub.status === 'canceling') {
      return res.status(400).json({ error: 'Subscription is already cancelled' });
    }

    const stripeSub = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    await prisma.subscription.update({
      where: { teamId: team.id },
      data: { status: 'canceling' },
    });

    const cancelAt = new Date(stripeSub.current_period_end * 1000);
    res.json({
      cancelAt: cancelAt.toISOString(),
      cancelAtFormatted: cancelAt.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      }),
    });
  } catch (err) {
    captureError('Cancel subscription error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// GET /billing/card/subscription/:subscriptionId
app.get('/billing/card/subscription/:subscriptionId', authenticateToken, async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    // Verify this subscriptionId actually belongs to one of the requester's
    // teams before querying Stripe — otherwise any authenticated user could
    // pass an arbitrary subscriptionId and read someone else's card details.
    const owningTeamMember = await prisma.teamMember.findFirst({
      where: { userId: req.user.id, team: { subscription: { stripeSubscriptionId: subscriptionId } } },
    });
    if (!owningTeamMember) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let paymentMethod = null;

    // Try subscription first — may have its own default payment method
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['default_payment_method'],
      });
      if (subscription.default_payment_method) {
        paymentMethod = subscription.default_payment_method;
      }
    } catch {
      // Subscription not found (cancelled/deleted) — fall through to customer lookup
    }

    // Fall back to the customer's saved card via DB → Stripe
    if (!paymentMethod) {
      const teamMember = await prisma.teamMember.findFirst({
        where: { userId: req.user.id },
        include: { team: true },
      });

      const customerId = teamMember?.team?.stripeCustomerId;
      if (!customerId) {
        return res.status(404).json({ error: 'No card found' });
      }

      const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
      if (!list.data.length) {
        return res.status(404).json({ error: 'No card found' });
      }
      paymentMethod = list.data[0];
    }

    const card = paymentMethod.card;

    return res.json({
      subscriptionId,
      paymentMethodId: paymentMethod.id,
      brand: card.brand,
      last4: card.last4,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
      funding: card.funding,
      country: card.country || null,
    });
  } catch (err) {
    captureError('Stripe card lookup error:', err);
    res.status(500).json({ error: 'Failed to fetch card details' });
  }
});

app.patch(
  '/api/notifications/:id/read',
  authenticateToken,
  async (req, res) => {
    try {
      const notification = await prisma.notification.update({
        where: {
          id: req.params.id,
          userId: req.user.id, // security: only update own
        },
        data: { read: true },
      });

      res.json({ success: true, notification });
    } catch (err) {
      captureError(err);
      res.status(500).json({ error: 'Failed to mark as read' });
    }
  },
);

app.post(
  '/api/notifications/mark-all-read',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.notification.updateMany({
        where: {
          userId: req.user.id,
          read: false,
        },
        data: { read: true },
      });

      res.json({ success: true });
    } catch (err) {
      captureError(err);
      res.status(500).json({ error: 'Failed to mark all as read' });
    }
  },
);

// ─── Password Reset ──────────────────────────────────────────────────────────

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  // Always respond success to prevent email enumeration
  res.json({ message: 'If that email is registered you will receive a reset link.' });

  if (!email) return;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return;

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.verificationToken.upsert({
      where: { token },
      update: { expires },
      create: { identifier: email, token, expires },
    });

    const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;

    if (!resend) return;
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Annoture <noreply@annoture.com>',
      to: email,
      subject: 'Reset your Annoture password',
      html: emailTemplate({
        badgeText: 'Password Reset',
        heading: 'Reset your password',
        body: '<p>Click the button below to reset your password. This link expires in <strong style="color:#fff;">1 hour</strong>.</p>',
        ctaUrl: resetUrl,
        ctaLabel: 'Reset password',
        footerNote: "If you didn't request a password reset, you can safely ignore this email — your password won't change.",
      }),
    });
  } catch (err) {
    captureError('forgot-password error:', err);
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const record = await prisma.verificationToken.findUnique({ where: { token } });
    if (!record || record.expires < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashed = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { email: record.identifier },
      data: { password: hashed },
    });

    await prisma.verificationToken.delete({ where: { token } });

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    captureError('reset-password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── OAuth (Google & GitHub) ──────────────────────────────────────────────────

app.get('/api/auth/google', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('oauth_state', state, {
    httpOnly: true,
    path: '/',
    maxAge: 10 * 60 * 1000,
    sameSite: 'lax',
    ...(isProd && { secure: true }),
  });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const frontendUrl = process.env.APP_URL || 'http://localhost:3000';
  const expectedState = req.cookies?.oauth_state;
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('oauth_state', { httpOnly: true, path: '/', sameSite: 'lax', ...(isProd && { secure: true }) });

  if (!state || !expectedState || state !== expectedState) {
    return res.redirect(`${frontendUrl}/callback?error=state_mismatch`);
  }

  if (error || !code) {
    return res.redirect(`${frontendUrl}/callback?error=oauth_cancelled`);
  }

  try {
    const redirectUri = `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/api/auth/google/callback`;

    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const profileRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });

    const { email, name, sub: providerAccountId } = profileRes.data;

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, name, password: '', status: 'active' },
      });
    } else if (user.status !== 'active') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });
    }

    await prisma.account.upsert({
      where: { provider_providerAccountId: { provider: 'google', providerAccountId } },
      update: { access_token: tokenRes.data.access_token },
      create: { userId: user.id, type: 'oauth', provider: 'google', providerAccountId, access_token: tokenRes.data.access_token },
    });

    const memberships = await prisma.teamMember.findMany({
      where: { userId: user.id },
      select: { teamId: true, role: true },
    });

    const jwtToken = jwt.sign(
      { jti: crypto.randomUUID(), id: user.id, email: user.email, name: user.name, teams: memberships },
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
    );

    setAuthCookie(res, jwtToken);
    res.redirect(`${frontendUrl}/callback?success=1`);
  } catch (err) {
    captureError('Google OAuth error:', err?.response?.data || err.message);
    res.redirect(`${process.env.APP_URL || 'http://localhost:3000'}/callback?error=oauth_failed`);
  }
});

app.get('/api/auth/github', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('oauth_state', state, {
    httpOnly: true,
    path: '/',
    maxAge: 10 * 60 * 1000,
    sameSite: 'lax',
    ...(isProd && { secure: true }),
  });
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/api/auth/github/callback`,
    scope: 'user:email',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/api/auth/github/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const frontendUrl = process.env.APP_URL || 'http://localhost:3000';
  const expectedState = req.cookies?.oauth_state;
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('oauth_state', { httpOnly: true, path: '/', sameSite: 'lax', ...(isProd && { secure: true }) });

  if (!state || !expectedState || state !== expectedState) {
    return res.redirect(`${frontendUrl}/callback?error=state_mismatch`);
  }

  if (error || !code) {
    return res.redirect(`${frontendUrl}/callback?error=oauth_cancelled`);
  }

  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/api/auth/github/callback`,
      },
      { headers: { Accept: 'application/json' } },
    );

    const accessToken = tokenRes.data.access_token;

    const [profileRes, emailsRes] = await Promise.all([
      axios.get('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}` } }),
      axios.get('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${accessToken}` } }),
    ]);

    const primaryEmail = emailsRes.data.find((e) => e.primary && e.verified)?.email;
    const email = primaryEmail || profileRes.data.email;
    const name = profileRes.data.name || profileRes.data.login;
    const providerAccountId = String(profileRes.data.id);

    if (!email) {
      return res.redirect(`${frontendUrl}/callback?error=no_email`);
    }

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, name, password: '', status: 'active' },
      });
    } else if (user.status !== 'active') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });
    }

    await prisma.account.upsert({
      where: { provider_providerAccountId: { provider: 'github', providerAccountId } },
      update: { access_token: accessToken },
      create: { userId: user.id, type: 'oauth', provider: 'github', providerAccountId, access_token: accessToken },
    });

    const memberships = await prisma.teamMember.findMany({
      where: { userId: user.id },
      select: { teamId: true, role: true },
    });

    const jwtToken = jwt.sign(
      { jti: crypto.randomUUID(), id: user.id, email: user.email, name: user.name, teams: memberships },
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
    );

    setAuthCookie(res, jwtToken);
    res.redirect(`${frontendUrl}/callback?success=1`);
  } catch (err) {
    captureError('GitHub OAuth error:', err?.response?.data || err.message);
    res.redirect(`${process.env.APP_URL || 'http://localhost:3000'}/callback?error=oauth_failed`);
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

// PATCH /api/users/me — update name and/or email
app.patch('/api/users/me', authenticateToken, async (req, res) => {
  const { name, email } = req.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (email !== undefined) data.email = email;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    if (email) {
      const existing = await prisma.user.findFirst({
        where: { email, NOT: { id: req.user.id } },
      });
      if (existing) return res.status(409).json({ error: 'Email already in use' });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { id: true, name: true, email: true },
    });

    res.json({ user });
  } catch (err) {
    captureError('PATCH /api/users/me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.password) {
      return res.status(400).json({ error: 'Cannot change password for OAuth accounts' });
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.user.id }, data: { password: hashed } });

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    captureError('change-password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/users/me/notifications — update notification preferences
app.patch('/api/users/me/notifications', authenticateToken, async (req, res) => {
  const { taskAssigned, taskOverdue, dueToday, teamInvite } = req.body;
  const prefs = { taskAssigned, taskOverdue, dueToday, teamInvite };

  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { notificationPrefs: prefs },
      select: { id: true, notificationPrefs: true },
    });

    res.json({ notificationPrefs: user.notificationPrefs });
  } catch (err) {
    captureError('PATCH /api/users/me/notifications error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/users/me — permanently delete a user account.
// Requires email confirmation in the body.
// Blocks if the user is the sole owner of any team (they must delete it first).
app.delete('/api/users/me', authenticateToken, async (req, res) => {
  const { email } = req.body;
  if (!email || email !== req.user.email) {
    return res.status(400).json({ error: 'Email confirmation does not match' });
  }

  const userId = req.user.id;

  try {
    // Check for sole-owner teams — block deletion if found
    const ownedTeams = await prisma.teamMember.findMany({
      where: { userId, role: 'owner' },
      select: {
        teamId: true,
        team: {
          select: {
            name: true,
            _count: { select: { members: true } },
            members: { where: { role: 'owner' }, select: { userId: true } },
          },
        },
      },
    });

    const soleOwnerTeams = ownedTeams.filter(
      (m) => m.team.members.length === 1 && m.team.members[0].userId === userId,
    );

    if (soleOwnerTeams.length > 0) {
      const names = soleOwnerTeams.map((m) => `"${m.team.name}"`).join(', ');
      return res.status(400).json({
        error: `You are the sole owner of ${names}. Please delete your team or transfer ownership before deleting your account.`,
        code: 'SOLE_OWNER',
      });
    }

    // Revoke the active session before deleting so the cookie becomes immediately invalid
    if (req.user.jti) revokedJtis.add(req.user.jti);

    // Remove all FK-blocking records for this user, then delete the user.
    // Reports on shared team boards are anonymised rather than deleted to preserve team QA history.
    await prisma.$transaction([
      // Anonymise reports so team boards keep their cards but PII is removed
      prisma.qAReport.updateMany({
        where: { userId },
        data: { userId: null, userName: 'Deleted User' },
      }),
      prisma.comment.deleteMany({ where: { userId } }),
      prisma.teamMember.deleteMany({ where: { userId } }),
      prisma.siteUser.deleteMany({ where: { userId } }),
      prisma.notification.deleteMany({ where: { userId } }),
      prisma.activity.deleteMany({ where: { OR: [{ userId }, { actorId: userId }] } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);

    clearAuthCookie(res);
    res.json({ message: 'Account deleted' });
  } catch (err) {
    captureError('DELETE /api/users/me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sentry error handler — captures unhandled Express errors before your own handler
Sentry.setupExpressErrorHandler(app);

// Global Express error handler — handles multer errors + final fallback
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  if (err.message?.includes('Invalid file type')) {
    return res.status(400).json({ error: err.message });
  }

  if (err.message?.startsWith('CORS:')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // Anything that reaches here is an unhandled server error
  captureError('Unhandled server error', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.io — authenticate via JWT from httpOnly cookie or auth handshake token
io.use((socket, next) => {
  // Prefer cookie (set by setAuthCookie); fall back to explicit auth.token for backward compat
  const cookieHeader = socket.handshake.headers?.cookie || '';
  const cookieToken = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('token='))
    ?.slice('token='.length);
  const token = cookieToken || socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized'));
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Unauthorized'));
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  // Client sends either a string slug or { slug } object
  const resolveSlug = (payload) =>
    typeof payload === 'string' ? payload : payload?.slug;

  socket.on('join:site', (payload) => {
    const slug = resolveSlug(payload);
    if (slug) socket.join(`site:${slug}`);
  });
  socket.on('leave:site', (payload) => {
    const slug = resolveSlug(payload);
    if (slug) socket.leave(`site:${slug}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`QA backend running in ${ENV} mode on port ${PORT}`);
});
