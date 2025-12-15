const express = require('express');
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const slugify = require('slugify');
const {
  uploadBufferToR2,
  getSignedR2Url,
  generateThumbnail,
} = require('./cloudlare/cloudflare-r2');

const app = express();
const prisma = new PrismaClient();
const PORT = 4000;

require('dotenv').config();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const fileFilter = (req, file, cb) => {
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

  if (!allowed.includes(file.mimetype)) {
    return cb(
      new Error('Invalid file type. Only images and PDFs are allowed.'),
      false
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

const bcrypt = require('bcryptjs');

const { formatDistanceToNow } = require('date-fns');

app.get('/api/activities', authenticateToken, async (req, res) => {
  try {
    const activitiesDb = await prisma.activity.findMany({
      where: { userId: req.user.id },
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
      let status = undefined;

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
        link: a.report
          ? `/reports/${a.report.siteName.toLowerCase()}?report=${a.report.id}`
          : null,
      };
    });

    res.json(activities);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch activities' });
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

// utils/activity.js (or in your app.js)
async function logActivity({
  userId,
  actorId,
  type,
  reportId,
  message,
  status,
  priority,
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

    res.status(201).json({
      message: 'User registered',
      user: { id: user.id, email: user.email },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const jwt = require('jsonwebtoken');

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

    const token = jwt.sign(
      {
        name: user.name,
        id: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
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

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, name: true },
  });

  if (!user) return res.sendStatus(404);

  res.json({ user });
});

app.post(
  '/api/report',
  authenticateToken,
  uploadAttachments.single('screenshot'),
  async (req, res) => {
    const { url, comment, x, y, title, priority, type } = req.body;
    const file = req.file;
    const domain = new URL(url).hostname.replace('www.', '');

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

    if (!file) return res.status(400).json({ error: 'No screenshot uploaded' });

    try {
      const key = `screenshots/${Date.now()}_${file.originalname}`;
      await uploadBufferToR2(file.buffer, key, file.mimetype);
      const signedUrl = await getSignedR2Url(key);

      console.log(signedUrl);

      const report = await prisma.qAReport.create({
        data: {
          url,
          site: domain,
          slug: slugify(siteName, { lower: true }),
          siteName: siteName,
          title,
          priority,
          type,
          comment,
          x: parseInt(x),
          y: parseInt(y),
          imagePath: signedUrl,
          // userId: req.user.id,
          user: {
            connect: { id: req.user.id }, // ✅ Correct way to link existing user
          },
          userName: req.user.name,
          Site: {
            create: {
              name: siteName,
              domain: domain,
              slug: slugify(siteName, { lower: true }),
              users: {
                connect: { id: req.user.id }, // 👈 connect creator to the site
              },
            },
          },
        },
      });

      // Create a JSON metadata file alongside the image
      const metadata = {
        id: report.id,
        image: signedUrl,
        title,
        priority,
        type,
        comment,
        url,
        site: domain,
        slug: slugify(siteName, { lower: true }),
        siteName: siteName,
        x: parseInt(x),
        y: parseInt(y),
        timestamp: report.timestamp.toISOString(),
        userId: req.user.id,
        userName: req.user.name,
      };

      const metadataPath = path.join('uploads', `${report.id}.json`);
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      res.json(report);
    } catch (error) {
      console.error('Error saving report:', error);
      res.status(500).json({ error: 'Failed to save report' });
    }
  }
);

// GET /api/sites
app.get('/api/sites', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // Step 1: Find all site domains the user has access to (via Site.users relation)
    const accessibleSites = await prisma.site.findMany({
      where: {
        users: {
          some: { id: userId },
        },
      },
      select: {
        domain: true,
      },
    });

    const invitedSiteDomains = accessibleSites.map((site) => site.domain);

    // Step 2: Get all reports for these domains
    const groupedSites = await prisma.qAReport.groupBy({
      by: ['site', 'slug'],
      where: {
        site: { in: invitedSiteDomains },
        archived: false,
      },
      _count: { site: true },
      _max: { timestamp: true },
      orderBy: { _max: { timestamp: 'desc' } },
    });

    // Step 3: Enrich with latest report data
    const sitesWithTimestamps = await Promise.all(
      groupedSites.map(async (group) => {
        const latest = await prisma.qAReport.findFirst({
          where: {
            site: group.site,
            archived: false,
          },
          orderBy: { timestamp: 'desc' },
          select: { id: true, timestamp: true, siteName: true },
        });

        return {
          id: latest?.id,
          site: group.site,
          siteName: latest?.siteName,
          count: group._count.site,
          lastUpdated: latest?.timestamp,
        };
      })
    );

    res.json(sitesWithTimestamps);
  } catch (error) {
    console.error('Error fetching accessible sites:', error);
    res.status(500).json({ error: 'Failed to fetch accessible sites' });
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

    res.json(tasks);
  } catch (error) {
    console.error('Error generating tasks:', error);
    res.status(500).json({ error: 'Failed to load tasks' });
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

    res.json(archivedReports);
  } catch (error) {
    console.error('Failed to fetch archived reports:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/site/:site
app.get('/api/site/:slug', authenticateToken, async (req, res) => {
  const { slug } = req.params;
  const userId = req.user.id;

  try {
    // Step 1: Find the site and check access
    const site = await prisma.site.findFirst({
      where: { slug },
      include: {
        users: {
          where: { id: userId },
          select: { id: true },
        },
      },
    });

    if (!site || site.users.length === 0) {
      return res.status(403).json({ error: 'Access denied to this site' });
    }

    // Step 2: Fetch all reports for the site
    const reports = await prisma.qAReport.findMany({
      where: { slug },
      orderBy: { timestamp: 'desc' },
    });

    res.json(reports);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// Invite a user to collaborate on a site
app.post('/api/site/:slug/invite', async (req, res) => {
  const { slug } = req.params;
  const { email } = req.body;

  if (!slug || !email) {
    return res.status(400).json({ error: 'slug and email are required' });
  }

  try {
    // 1. Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 2. Check if site exists
    const site = await prisma.site.findFirst({
      where: { slug },
    });

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
      files.map((file) => fs.promises.unlink(path.join(UPLOAD_DIR, file)))
    );

    // Optionally, also delete all entries in your database table
    await prisma.qAReport.deleteMany();

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
        (resolvedAt.getTime() - new Date(existing.timestamp).getTime()) / 60000
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

      res.json({ avgResolutionTimeHours: avgHours });
    } catch (error) {
      console.error('Error calculating avg resolution time:', error);
      res
        .status(500)
        .json({ error: 'Failed to calculate average resolution time' });
    }
  }
);

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
            })
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

      res.json(comment);
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ error: 'Unable to create comment with attachments' });
    }
  }
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
          }))
        ),
      }))
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
    const report = await prisma.qAReport.findUnique({
      where: { id },
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Delete associated image file
    if (report.imagePath) {
      const imagePath = path.join(__dirname, report.imagePath);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    // Delete metadata JSON file if it exists
    const metadataPath = path.join(__dirname, 'uploads', `${id}.json`);
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }

    // Delete the report from the DB
    await prisma.qAReport.delete({
      where: { id },
    });

    res.json({ message: 'Report deleted successfully' });
  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
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
  console.log(`QA backend running at http://localhost:${PORT}`);
});
