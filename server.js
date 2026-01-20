const express = require('express');
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const { Resend } = require('resend');
const cheerio = require('cheerio');
const slugify = require('slugify');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { getUserTeams } = require('./services/userTeams.service');

const {
  uploadBufferToR2,
  getSignedR2Url,
  generateThumbnail,
} = require('./cloudlare/cloudflare-r2');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 4000;
const ENV = process.env.NODE_ENV || 'development';

require('dotenv').config();

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

    const teamId = obj?.metadata?.teamId;

    switch (event.type) {
      case 'checkout.session.completed': {
        if (!obj.subscription) break;

        const sub = await stripe.subscriptions.retrieve(obj.subscription);

        await prisma.subscription.upsert({
          where: { teamId },
          update: {
            plan: mapPriceToPlan(sub.items.data[0].price.id),
            interval: sub.items.data[0].price.recurring.interval,
            status: sub.status,
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            stripePriceId: sub.items.data[0].id,
            currentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000)
              : null,
            teamId,
          },
          create: {
            teamId,
            plan: mapPriceToPlan(sub.items.data[0].price.id),
            interval: sub.items.data[0].price.recurring.interval,
            status: sub.status,
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            stripePriceId: sub.items.data[0].id,
            currentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000)
              : null,
          },
        });

        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        await prisma.subscription.upsert({
          where: { teamId },
          update: {
            plan: mapPriceToPlan(obj.items.data[0].price.id),
            interval: obj.items.data[0].price.recurring.interval,
            status: obj.status,
            stripePriceId: obj.items.data[0].id,
            currentPeriodEnd: obj.current_period_end
              ? new Date(obj.current_period_end * 1000)
              : null,
            teamId,
          },
          create: {
            teamId,
            plan: mapPriceToPlan(obj.items.data[0].price.id),
            interval: obj.items.data[0].price.recurring.interval,
            status: obj.status,
            stripeSubscriptionId: obj.id,
            stripePriceId: obj.items.data[0].id,
            currentPeriodEnd: obj.current_period_end
              ? new Date(obj.current_period_end * 1000)
              : null,
          },
        });

        break;
      }

      case 'customer.subscription.deleted': {
        await prisma.subscription.update({
          where: { teamId },
          data: {
            status: 'canceled',
            plan: 'FREE',
          },
        });
        break;
      }
    }

    res.json({ received: true });
  },
);

app.use(
  cors({
    origin: process.env.APP_URL,
    credentials: true, // if you want cookies or auth headers
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const fileFilter = (req, file, cb) => {
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

  if (!allowed.includes(file.mimetype)) {
    return cb(
      new Error('Invalid file type. Only images and PDFs are allowed.'),
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

const bcrypt = require('bcryptjs');

const { formatDistanceToNow } = require('date-fns');

app.get('/api/activities', authenticateToken, async (req, res) => {
  try {
    const activitiesDb = await prisma.activity.findMany({
      where: {
        OR: [
          { userId: req.user.id },
          {
            report: {
              Site: {
                team: {
                  members: {
                    some: { userId: req.user.id },
                  },
                },
              },
            },
          },
        ],
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
          : null,
      };
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(activities);
  } catch (err) {
    console.error(err);
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

    const overdueTasks = await prisma.qAReport.findMany({
      where: {
        userId,
        dueDate: { lt: startOfDay },
        status: { not: 'resolved' },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        siteName: true,
      },
    });

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

    const dueTodayTasks = await prisma.qAReport.findMany({
      where: {
        userId,
        dueDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        status: { not: 'resolved' },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        siteName: true,
      },
    });

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
    console.error(err);
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
    console.error('Invalid URL:', url);
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
    console.error('Failed to log activity:', err);
  }
}

module.exports = logActivity;

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, team } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashedPassword,
      },

      include: {
        sites: true,
      },
    });

    const token = jwt.sign(
      {
        name: user.name,
        id: user.id,
        email: user.email,
        teams: [],
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      },
    );

    res.status(201).json({
      message: 'User registered',
      user: { id: user.id, email: user.email },
      token,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const memberships = await prisma.teamMember.findMany({
      where: { userId: user.id },
      select: { teamId: true, role: true },
    });

    const token = jwt.sign(
      {
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
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

async function requireActivePlan(req, res, next) {
  try {
    // Get teamId from request body, or fall back to the first team the user belongs to
    let teamId = req.body.teamId;

    if (!teamId) {
      const userWithTeams = await prisma.user.findUnique({
        where: { id: req.user.id },
        include: { teamMembers: true },
      });
      teamId = userWithTeams?.teamMembers?.[0]?.teamId;
    }

    if (!teamId) {
      return res.status(400).json({ error: 'No team selected' });
    }

    // Fetch the team along with subscription, members, and report counts
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        subscription: true, // subscription relation
        sites: { select: { _count: { select: { reports: true } } } },
        members: true,
      },
    });

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Plan comes from subscription if it exists, otherwise default to 'free'
    const plan = team.subscription?.plan || 'free';
    const subscriptionStatus = team.subscription?.status || 'active';

    // Plan limits
    const PLAN_LIMITS = {
      free: { reports: 50, members: 3, sites: 3 },
      starter: { reports: 1000, members: 10, sites: 5 },
      team: { reports: 5000, members: 50, sites: Infinity },
      agency: { reports: Infinity, members: Infinity, sites: Infinity },
    };

    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    // Block inactive subscriptions for paid plans
    if (plan !== 'free' && subscriptionStatus !== 'active') {
      return res.status(402).json({
        error: 'Your subscription is inactive. Please update billing.',
      });
    }

    // Count reports across all team sites
    const totalReports = team.sites.reduce(
      (sum, site) => sum + (site._count?.reports || 0),
      0,
    );

    // Enforce report limit
    if (totalReports >= limits.reports) {
      return res.status(403).json({
        error: 'Report limit reached for this plan',
      });
    }

    // Enforce member limit
    if (team.members.length > limits.members) {
      return res.status(403).json({
        error: 'Member limit exceeded for this plan',
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
    console.error('Plan check failed', err);
    res.status(500).json({ error: 'Subscription check failed' });
  }
}

app.post('/sites/create', authenticateToken, async (req, res) => {
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

    res.json({ site });
  } catch (err) {
    console.error('Create site error:', err);

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
    const { name, plan = 'free' } = req.body;
    const file = req.file;

    try {
      let logoUrl = null;

      if (file) {
        // Generate a unique key for R2
        const key = `team-logos/${Date.now()}_${file.originalname}`;

        // Upload to Cloudflare R2
        await uploadBufferToR2(file.buffer, key, file.mimetype);

        // Get a signed URL to serve publicly (optional)
        logoUrl = await getSignedR2Url(key);
      }
      const team = await prisma.team.create({
        data: {
          name,
          logo: logoUrl,
          plan,
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

app.post('/teams/:teamId/invite-link', async (req, res) => {
  const { teamId } = req.params;
  const { role = 'member' } = req.body;

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const code = handleGenerateNewCode();

  const invite = await prisma.teamInvite.create({
    data: { teamId, code, expiresAt, role, email: null },
  });

  res.json({
    code,
    inviteUrl: `${process.env.APP_URL}/invite/${code}`,
  });
});

app.get('/teams/:teamId/invite-link', async (req, res) => {
  const { teamId } = req.params;
  const { role = 'member' } = req.body;

  try {
    // 1️⃣ Get most recent non-expired invite
    const invite = await prisma.teamInvite.findFirst({
      where: {
        teamId,
        expiresAt: { gt: new Date() }, // still valid
      },
      orderBy: { createdAt: 'desc' },
    });

    if (invite) {
      return res.json({
        code: invite.code,
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
        inviteUrl: `${process.env.APP_URL}/invite/${newInvite.code}`,
      });
    }
  } catch (err) {
    console.error('Failed to load invite code', err);
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
    const { email, role = 'member' } = req.body;

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

    const inviteUrl = `${process.env.APP_URL}/regsiter?invite_code=${code}`;

    const emailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6;">
      <h2>You’ve been invited to join <strong>${
        team.name
      }</strong> on QA Tool</h2>

      <p><strong>${inviterName}</strong> has invited you to collaborate on their QA workspace.</p>

      <p>QA Tool helps teams capture website issues visually, add comments, and send them
      straight into a shared Kanban board — making QA faster and more collaborative.</p>

      <p style="margin-top: 16px;">
        <a href="${inviteUrl}"
          style="background:#2563eb;color:#fff;padding:10px 14px;border-radius:6px;
          text-decoration:none;display:inline-block;">
          Accept invite and join the team
        </a>
      </p>

      <p>If the button doesn’t work, copy and paste this link:</p>
      <p>${inviteUrl}</p>

      <p style="color:#666;font-size:13px;">
        This invite will expire on <strong>${expiresAt.toLocaleDateString()}</strong>.
      </p>

      <hr />

      <p style="color:#777;font-size:12px;">
        You’re receiving this because someone added your email to a QA Tool team invite.
        If you weren’t expecting this, you can safely ignore it.
      </p>
    </div>
  `;

    await resend.emails.send({
      from: 'QA Tool <noreply@qatool.app>',
      to: email,
      subject: `You’ve been invited to join ${team.name} on QA Tool`,
      html: emailHtml,
    });

    res.json({ success: true });
  },
);

app.post('/teams/join', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { code } = req.body;

  const invite = await prisma.teamInvite.findUnique({
    where: { code },
    include: { team: true },
  });

  if (!invite) return res.status(400).json({ error: 'Invalid invite link' });

  // check expiry
  if (invite.expiresAt && invite.expiresAt < new Date())
    return res.status(400).json({ error: 'This invite has expired' });

  // already accepted / used
  if (invite.used) {
    return res.status(400).json({ error: 'This invite has already been used' });
  }

  // prevent double-joining
  const existingMember = await prisma.teamMember.findFirst({
    where: { teamId: invite.teamId, userId },
  });

  if (existingMember) {
    return res.status(200).json({ joined: true, alreadyMember: true });
  }

  await prisma.$transaction([
    prisma.teamMember.create({
      data: {
        teamId: invite.teamId,
        userId,
        role: invite.role,
      },
    }),
    prisma.teamInvite.update({
      where: { id: invite.id },
      data: { used: true },
    }),
  ]);

  res.json({ joined: true });
});

app.get('/teams/:teamId/members', authenticateToken, async (req, res) => {
  const { teamId } = req.params;

  try {
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
    console.error(err);
    res.status(500).json({ error: 'Failed to load team members' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const user = await getUserTeams(userId);

  if (!user) return res.sendStatus(404);

  // 👇 pick the first owned team (you could expand this for multiple teams)
  const ownedTeam = user.teamMembers?.[0]?.team ?? null;
  const teamId = ownedTeam?.id ?? null;
  const isOwner = Boolean(teamId);

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
    },
  });
});

app.post(
  '/api/report',
  authenticateToken,
  requireActivePlan,
  uploadAttachments.single('screenshot'),
  async (req, res) => {
    const { url, comment, x, y, title, priority, type, dueDate, teamId } =
      req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No screenshot uploaded' });

    const domain = new URL(url).hostname.replace('www.', '');

    // Fetch site name from the page (fallback to domain)
    let siteName = '';
    try {
      const response = await axios.get(url);
      const $ = cheerio.load(response.data);
      siteName =
        $('meta[property="og:site_name"]').attr('content') ||
        $('title').text().trim() ||
        domain;
    } catch (err) {
      console.warn(`Failed to fetch site name from ${url}:`, err.message);
      siteName = domain;
    }

    try {
      // Make sure user exists
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) return res.status(400).json({ error: 'User not found' });

      // Determine team
      const userTeamId = teamId || (await getUserTeamIds(req))[0];
      if (!userTeamId)
        return res.status(400).json({ error: 'No team available' });

      // Make sure team exists
      const team = await prisma.team.findUnique({ where: { id: userTeamId } });
      if (!team) return res.status(400).json({ error: 'Team not found' });

      // Upload screenshot
      const key = `screenshots/${Date.now()}_${file.originalname}`;
      await uploadBufferToR2(file.buffer, key, file.mimetype);
      const signedUrl = await getSignedR2Url(key);

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
          priority,
          type,
          dueDate: dueDate ? new Date(dueDate) : null,
          comment,
          x: parseInt(x),
          y: parseInt(y),
          imagePath: signedUrl,
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

      // Create metadata JSON
      const metadata = {
        id: report.id,
        image: signedUrl,
        title,
        priority,
        pagePath,
        type,
        comment,
        url,
        site: domain,
        dueDate: dueDate ? new Date(dueDate) : null,
        slug,
        siteName,
        x: parseInt(x),
        y: parseInt(y),
        timestamp: report.timestamp.toISOString(),
        userId: req.user.id,
        userName: req.user.name,
      };

      const metadataPath = path.join('uploads', `${report.id}.json`);
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      await prisma.user.update({
        where: { id: req.user.id },
        data: { lastActive: new Date() },
      });

      res.json(report);
    } catch (error) {
      console.error('Error saving report:', error);
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
          imagePath: report.imagePath,
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

    // 👤 update activity
    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(grouped);
  } catch (error) {
    console.error('Error fetching reports:', error);
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

          // ✅ Invited to the board (Site)
          {
            Site: {
              team: {
                members: {
                  some: {
                    userId,
                  },
                },
              },
            },
          },
        ],
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
      dueDate: report.dueDate ? report.dueDate.toISOString() : null,
      timestamp: report.timestamp.toISOString(),
    });
  } catch (error) {
    console.error('Error fetching report:', error);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// GET /api/sites
app.get('/api/sites', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1️⃣ Get all sites the user has access to
    let accessibleSites = await prisma.site.findMany({
      where: {
        OR: [
          { users: { some: { id: userId } } },
          {
            team: {
              members: { some: { userId } },
            },
          },
        ],
      },
      select: {
        id: true,
        domain: true,
        siteUsers: { where: { userId }, select: { isPinned: true } },
      },
    });

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
        slug: site.domain,
        siteName: latest?.siteName || site.domain,
        members: membersByDomain[site.domain] || [],
        counts,
        priorities,
        total: totalReports,
        lastUpdated: latest?.timestamp || null,
        isPinned: site.siteUsers[0]?.isPinned ?? false,
        siteStatus: siteData[site.domain]?.archived ? 'archived' : 'active',
      };
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(sitesWithDetails);
  } catch (error) {
    console.error('Error fetching accessible sites:', error);
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
      select: { id: true },
    });

    if (!site) {
      return res
        .status(404)
        .json({ error: `Site with slug "${slug}" not found` });
    }

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
    console.error('Failed to pin site:', err); // This will log the actual error
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
    console.error('Failed to unpin site:', err);
    res.status(500).json({ error: 'Failed to unpin site' });
  }
});

app.get('/api/users-tasks', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // Step 1: Get all sites the user has access to
    const sites = await prisma.site.findMany({
      where: {
        users: {
          some: { id: userId },
        },
      },
      select: {
        domain: true,
        name: true,
      },
    });

    const siteDomains = sites.map((s) => s.domain);

    // Step 2: Get all reports for those sites
    const reports = await prisma.qAReport.findMany({
      where: {
        site: { in: siteDomains },
        archived: false,
        status: { not: 'done' },
        userId: userId,
      },
      orderBy: { timestamp: 'desc' },
    });

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

      return input.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
      });
    }

    // Step 3: Transform into your TASK format
    const tasks = reports.map((r) => ({
      id: r.id,
      title: r.comment || 'Untitled Task',
      status: r.status || 'Open',
      priority: r.priority || 'Medium', // if you add priority later, this will match automatically
      dueDate: formatDate(r.timestamp),
      project: r.siteName || r.site,
      statusColor: statusColors[r.status] || 'blue',
    }));

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(tasks);
  } catch (error) {
    console.error('Error generating tasks:', error);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

app.get('/api/tasks', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    /**
     * 1️⃣ Get all ACTIVE sites the user has access to
     */
    const sites = await prisma.site.findMany({
      where: {
        users: {
          some: { id: userId },
        },
      },
      select: {
        domain: true,
        name: true,
      },
    });

    if (!sites.length) {
      return res.json([]);
    }

    const siteDomains = sites.map((s) => s.domain);

    /**
     * 2️⃣ Fetch all NON-ARCHIVED tasks for those sites
     */
    const reports = await prisma.qAReport.findMany({
      where: {
        site: { in: siteDomains },
        archived: false,
        // status: { not: 'done' },
      },
      orderBy: { timestamp: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

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
      priority: r.priority || 'medium',
      site: r.site,
      siteName: r.siteName || r.site,
      createdBy: {
        id: r.user?.id,
        name: r.user?.name,
      },
      createdAt: r.timestamp,
      statusColor: statusColors[r.status] || 'blue',
      dueDate: r.dueDate,
      slug: r.slug,
    }));

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(tasks);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
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
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(archivedReports);
  } catch (error) {
    console.error('Failed to fetch archived reports:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/site/:site
app.get('/api/site/:slug', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { teamId } = req.query;

  if (!teamId) {
    return res.status(400).json({ error: 'teamId is required' });
  }

  const site = await prisma.site.findFirst({
    where: { slug, teamId },
  });

  console.log(slug);
  console.log(teamId);

  if (!site) {
    return res.status(403).json({ error: 'Access denied to this site' });
  }

  const reports = await prisma.qAReport.findMany({
    where: { siteId: site.id },
    orderBy: { timestamp: 'desc' },
  });

  res.json(reports);
});

// Invite a user to collaborate on a site
app.post('/api/site/:slug/invite', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const { email, userId, teamId } = req.body;

  const isAdmin = await prisma.teamMember.findFirst({
    where: {
      teamId: teamId,
      userId: req.user.id,
      role: 'owner',
    },
  });

  if (!isAdmin) {
    return res.status(403).json({ error: 'Only admins can invite users' });
  }

  if (!slug || !email) {
    return res.status(400).json({ error: 'slug and email are required' });
  }

  if (!slug || (!email && !userId)) {
    return res.status(400).json({ error: 'Provide either email or userId' });
  }

  try {
    // 1. Load site
    const site = await prisma.site.findFirst({
      where: { slug },
      select: { id: true, teamId: true },
    });

    // 1. Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!site) {
      return res.status(404).json({ error: 'Site not found' });
    }

    console.log('Connecting user to site', { slug, userId: user.id });

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

    return res.json({ message: 'User invited successfully' });
  } catch (error) {
    console.error('Error inviting user:', error);
    return res.status(500).json({ error: 'Unable to invite user to site' });
  }
});

// Get all users who have access to a site
app.get('/api/site/:slug/users', async (req, res) => {
  const { slug } = req.params;

  if (!slug) {
    return res.status(400).json({ error: 'slug is required' });
  }

  try {
    const site = await prisma.site.findFirst({
      where: { slug },
      include: {
        users: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!site) {
      return res.status(404).json({ error: 'Site not found' });
    }

    res.json(site.users);
  } catch (error) {
    console.error('Error fetching users for site:', error);
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
    console.error('Failed to archive reports:', error);
    res.status(500).json({ error: 'Failed to archive/unarchive reports' });
  }
});

app.get('/uploads', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const reports = await prisma.qAReport.findMany({
      where: { userId: userId },
      orderBy: { timestamp: 'desc' },
    });
    res.json(reports);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

app.delete('/api/uploads', async (req, res) => {
  const UPLOAD_DIR = path.join(__dirname, 'uploads');

  try {
    const files = await fs.promises.readdir(UPLOAD_DIR);

    // Delete all files in the uploads directory
    await Promise.all(
      files.map((file) => fs.promises.unlink(path.join(UPLOAD_DIR, file))),
    );

    // Optionally, also delete all entries in your database table
    await prisma.qAReport.deleteMany();

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json({ message: 'All uploads and reports deleted successfully.' });
  } catch (error) {
    console.error('Error deleting uploads:', error);
    res.status(500).json({ error: 'Failed to delete uploads' });
  }
});

app.patch('/api/report/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ error: 'Status is required' });

  try {
    const existing = await prisma.qAReport.findUnique({ where: { id } });

    if (!existing) return res.status(404).json({ error: 'Report not found' });

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

    res.json(updatedReport);
  } catch (error) {
    console.error('Error updating report:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

app.get('/api/stats/open-issues', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const openCount = await prisma.qAReport.count({
      where: {
        status: 'new',
        userId,
        archived: false,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });
    res.json({ openIssues: openCount });
  } catch (error) {
    console.error('Error fetching open issues:', error);
    res.status(500).json({ error: 'Failed to fetch open issues count' });
  }
});

app.get('/api/stats/in-progress', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const inProgressCount = await prisma.qAReport.count({
      where: {
        status: 'inProgress',
        userId,
        archived: false,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });
    res.json({ inProgressIssues: inProgressCount });
  } catch (error) {
    console.error('Error fetching open issues:', error);
    res.status(500).json({ error: 'Failed to fetch open issues count' });
  }
});

app.get('/api/stats/resolved', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const resolvedCount = await prisma.qAReport.count({
      where: {
        status: 'done',
        userId,
        archived: false,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });
    res.json({ resolvedIssues: resolvedCount });
  } catch (error) {
    console.error('Error fetching open issues:', error);
    res.status(500).json({ error: 'Failed to fetch open issues count' });
  }
});

app.get('/api/stats/issues-summary', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const [openCount, inProgressCount, doneCount] = await Promise.all([
      prisma.qAReport.count({
        where: { status: 'new', userId, archived: false },
      }),
      prisma.qAReport.count({
        where: { status: 'inProgress', userId, archived: false },
      }),
      prisma.qAReport.count({
        where: { status: 'done', userId, archived: false },
      }),
    ]);

    const total = openCount + inProgressCount + doneCount || 1; // prevent division by zero

    // calculate initial percentages
    let openPct = (openCount / total) * 100;
    let inProgressPct = (inProgressCount / total) * 100;
    let donePct = (doneCount / total) * 100;

    // round to 1 decimal
    openPct = Math.round(openPct * 10) / 10;
    inProgressPct = Math.round(inProgressPct * 10) / 10;
    donePct = Math.round(donePct * 10) / 10;

    // adjust to ensure sum = 100
    const sumPct = openPct + inProgressPct + donePct;
    const diff = 100 - sumPct;

    if (diff !== 0) {
      // add difference to the largest value
      const maxPct = Math.max(openPct, inProgressPct, donePct);
      if (maxPct === openPct) openPct += diff;
      else if (maxPct === inProgressPct) inProgressPct += diff;
      else donePct += diff;
    }

    const issuesSummary = [
      { name: 'Open', value: openCount, percentage: openPct, color: '#60A5FA' },
      {
        name: 'In Progress',
        value: inProgressCount,
        percentage: inProgressPct,
        color: '#FBBF24',
      },
      { name: 'Done', value: doneCount, percentage: donePct, color: '#34D399' },
    ];

    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActive: new Date() },
    });

    res.json(issuesSummary);
  } catch (error) {
    console.error('Error fetching issues summary:', error);
    res.status(500).json({ error: 'Failed to fetch issues summary' });
  }
});

// GET /api/stats/reports-this-week
app.get('/api/stats/reports-this-week', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const startOfWeek = new Date();
    startOfWeek.setUTCHours(0, 0, 0, 0);
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay()); // Sunday

    const count = await prisma.qAReport.count({
      where: {
        userId,
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
    console.error('Error fetching weekly report count:', error);
    res.status(500).json({ error: 'Failed to fetch reports this week' });
  }
});

// GET /api/stats/avg-resolution-time
app.get(
  '/api/stats/avg-resolution-time',
  authenticateToken,
  async (req, res) => {
    const userId = req.user.id;
    try {
      const reports = await prisma.qAReport.findMany({
        where: {
          userId,
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
      console.error('Error calculating avg resolution time:', error);
      res
        .status(500)
        .json({ error: 'Failed to calculate average resolution time' });
    }
  },
);

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
    const existing = await prisma.qAReport.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Report not found' });
    }

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
    console.error('Failed to update due date:', error);
    res.status(500).json({ error: 'Failed to update due date' });
  }
});

// PATCH /api/report/:id/status
app.patch('/api/report/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const updated = await prisma.qAReport.update({
      where: { id },
      data: { status },
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

    res.json(updated);
  } catch (error) {
    console.error('Failed to update status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// GET /api/report/:id/status
app.get('/api/report/:id/status', async (req, res) => {
  const { id } = req.params;

  try {
    const report = await prisma.qAReport.findUnique({
      where: { id },
      select: { status: true }, // Only fetch the 'status' field
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json(report); // will return { status: "some_status" }
  } catch (error) {
    console.error('Failed to get status:', error);
    res.status(500).json({ error: 'Failed to get status' });
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
    const existing = await prisma.qAReport.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Report not found' });
    }

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

    res.json(updatedReport);
  } catch (error) {
    console.error('Error updating priority:', error);
    res.status(500).json({ error: 'Failed to update priority' });
  }
});

// GET /api/report/:id/status
app.get('/api/report/:id/priority', async (req, res) => {
  const { id } = req.params;

  try {
    const report = await prisma.qAReport.findUnique({
      where: { id },
      select: { priority: true }, // Only fetch the 'priority' field
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json(report); // will return { priority: "some_status" }
  } catch (error) {
    console.error('Failed to get priority:', error);
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
    const { content, parentId } = req.body;
    const attachments = req.files;

    if (!reportId || !content) {
      return res
        .status(400)
        .json({ error: 'reportId and content are required' });
    }

    try {
      const uploadedAttachments = attachments?.length
        ? await Promise.all(
            attachments.map(async (file) => {
              const fileKey = `comments/${Date.now()}_${file.originalname}`;

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

      await prisma.notification.create({
        data: {
          userId: req.user.id,
          type: 'MENTION',
          commentId: comment.id,
          reportId: comment.reportId,
          message: `${req.user.name} mentioned you in a comment`,
        },
      });

      await prisma.user.update({
        where: { id: req.user.id },
        data: { lastActive: new Date() },
      });

      res.json(comment);
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ error: 'Unable to create comment with attachments' });
    }
  },
);

// Retrieve comments with attachments for a report
app.get('/api/reports/:reportId/comments', async (req, res) => {
  const { reportId } = req.params;

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
    console.error(error);
    res.status(500).json({ error: 'Unable to fetch comments' });
  }
});

app.delete('/api/report/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.$transaction(async (tx) => {
      // Get report incl. site id + image path
      const report = await tx.qAReport.findUnique({
        where: { id },
        select: { id: true, siteId: true, imagePath: true },
      });

      if (!report) {
        throw new Error('REPORT_NOT_FOUND');
      }

      const { siteId, imagePath } = report;

      // ---- FILE CLEANUP ----
      if (imagePath) {
        const abs = path.join(__dirname, imagePath);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      }

      const metadataPath = path.join(__dirname, 'uploads', `${id}.json`);
      if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);

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

    res.json({ message: 'Report deleted successfully' });
  } catch (error) {
    if (error instanceof Error && error.message === 'REPORT_NOT_FOUND') {
      return res.status(404).json({ error: 'Report not found' });
    }

    console.error('Error deleting report:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
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

    // Single Prisma query: get counts of members, projects, and QAReports
    const teamStats = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        _count: {
          select: {
            members: true, // team members
            sites: true, // projects
          },
        },
        sites: {
          select: {
            _count: {
              select: {
                reports: true, // QAReports per site
              },
            },
          },
        },
      },
    });

    if (!teamStats) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Sum all QAReports across the team’s sites
    const screenshotsCount = teamStats.sites.reduce(
      (acc, site) => acc + site._count.reports,
      0,
    );

    return res.json({
      teamId: teamStats.id,
      screenshotsCount,
      projectsCount: teamStats._count.sites,
      teamMembersCount: teamStats._count.members,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/teams', authenticateToken, async (req, res) => {
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
});

app.post('/billing/checkout', authenticateToken, async (req, res) => {
  const { teamId, priceId } = req.body;

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

  const plan = mapPriceToPlan(priceId);

  // ⭐ EXISTING SUBSCRIPTION → UPDATE PLAN IN STRIPE (NO NEW SUB)
  if (team.subscription?.stripeSubscriptionId) {
    await stripe.subscriptions.update(team.subscription.stripeSubscriptionId, {
      items: [
        {
          id: team.subscription.stripePriceId, // subscription item id
          price: priceId,
        },
      ],
      proration_behavior: 'create_prorations',
    });

    await prisma.team.update({
      where: { id: teamId },
      include: { subscription: true },
      data: { plan },
    });

    return res.json({ status: 'updated' });
  }

  // ⭐ NO SUBSCRIPTION → CREATE VIA CHECKOUT
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/billing/success?team=${teamId}`,
    cancel_url: `${process.env.APP_URL}/billing/cancelled`,
    subscription_data: {
      metadata: { teamId },
    },
    metadata: { teamId },
  });

  res.json({ url: session.url });
});

// GET /api/search?q=keyword
app.get('/api/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1)
    return res.json({ projects: [], issues: [], users: [] });

  const keyword = q.toString().toLowerCase();

  try {
    // Search Projects (Sites)
    const projects = await prisma.site.findMany({
      where: {
        name: { contains: keyword },
        users: { some: { id: req.user.id } }, // only accessible projects
      },
      select: { id: true, name: true, slug: true },
      take: 10,
      distinct: ['id'],
    });

    // Search Issues (QA Reports)
    const issues = await prisma.qAReport.findMany({
      where: {
        OR: [
          { comment: { contains: keyword } },
          { siteName: { contains: keyword } },
        ],
        userId: req.user.id,
        archived: false,
      },
      select: { id: true, comment: true, siteName: true, status: true },
      take: 10,
    });

    // Search Users
    const users = await prisma.user.findMany({
      where: {
        OR: [{ name: { contains: keyword } }, { email: { contains: keyword } }],
      },
      select: { id: true, name: true, email: true },
      take: 10,
    });

    res.json({ projects, issues, users });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to perform search' });
  }
});

app.get('/api/invoices', authenticateToken, async (req, res) => {
  try {
    // Get the user's team
    const teamMember = await prisma.teamMember.findFirst({
      where: { userId: req.user.id },
      include: { team: true },
    });

    if (!teamMember || !teamMember.team.stripeCustomerId) {
      return res
        .status(400)
        .json({ error: 'No Stripe customer linked to this team' });
    }

    const customerId = teamMember.team.stripeCustomerId;

    // Fetch invoices from Stripe
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 20, // adjust as needed
    });

    // Optionally, you can map the data to only return what you need
    const formattedInvoices = invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      amount_due: inv.amount_due,
      status: inv.status,
      created: inv.created,
      invoice_pdf: inv.invoice_pdf,
      number: inv.number,
      subscription: inv.subscription,
    }));

    res.json(formattedInvoices);
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

app.get('/billing/next-renewal/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice'],
    });

    let nextUnix;

    if (subscription.current_period_end) {
      nextUnix = subscription.current_period_end;
    } else if (subscription.latest_invoice?.lines?.data?.[0]?.period?.end) {
      nextUnix = subscription.latest_invoice.lines.data[0].period.end;
    } else {
      const anchor = subscription.billing_cycle_anchor;
      const interval = subscription.plan.interval;
      const count = subscription.plan.interval_count || 1;

      const date = new Date(anchor * 1000);
      if (interval === 'month') date.setMonth(date.getMonth() + count);
      if (interval === 'year') date.setFullYear(date.getFullYear() + count);

      nextUnix = Math.floor(date.getTime() / 1000);
    }

    const nextDate = new Date(nextUnix * 1000);

    const formattedDate = nextDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return res.json({
      subscriptionId,
      nextBillingDateFormatted: formattedDate, // 👉 January 21, 2026
      nextBillingDateUnix: nextUnix,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get next billing date' });
  }
});

// GET /billing/card/subscription/:subscriptionId
app.get('/billing/card/subscription/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    // 1) Get the subscription (expand payment method + customer for convenience)
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method', 'customer'],
    });

    let paymentMethod;

    // 2) If the subscription has a default payment method, use that
    if (subscription.default_payment_method) {
      paymentMethod = subscription.default_payment_method;
    } else {
      // 3) Otherwise fall back to customer's first saved card
      const customerId = subscription.customer;

      const list = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      });

      if (!list.data.length) {
        return res.status(404).json({
          error: 'No card found for this subscription or customer',
        });
      }

      paymentMethod = list.data[0];
    }

    const card = paymentMethod.card;

    return res.json({
      subscriptionId,
      paymentMethodId: paymentMethod.id,
      brand: card.brand, // "visa", "mastercard"
      last4: card.last4, // "4242"
      exp_month: card.exp_month, // 4
      exp_year: card.exp_year, // 2026
      funding: card.funding, // "credit" | "debit" | "prepaid"
      country: card.country || null,
    });
  } catch (err) {
    console.error('Stripe subscription card lookup error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription card' });
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
      console.error(err);
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
      console.error(err);
      res.status(500).json({ error: 'Failed to mark all as read' });
    }
  },
);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  if (err.message?.includes('Invalid file type')) {
    return res.status(400).json({ error: err.message });
  }

  next(err);
});

app.listen(PORT, () => {
  console.log(`QA backend running in ${ENV} mode on port ${PORT}`);
  console.log('DATABASE_URL:', process.env.DATABASE_URL);
});
