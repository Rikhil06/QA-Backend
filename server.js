const express = require('express');
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const slugify = require('slugify');

const app = express();
const prisma = new PrismaClient();
const upload = multer({ dest: 'uploads/' });
const PORT = 4000;

require('dotenv').config();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const bcrypt = require('bcryptjs');

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
  upload.single('screenshot'),
  async (req, res) => {
    const { url, comment, x, y } = req.body;
    const file = req.file;
    const domain = new URL(url).hostname.replace('www.', '');

    let siteName = '';
    try {
      const response = await axios.get(url);
      const $ = cheerio.load(response.data);

      // Try Open Graph site name first
      siteName = $('meta[property="og:site_name"]').attr('content');

      // Fallback to title tag if og:site_name is not present
      if (!siteName) {
        siteName = $('title').text().trim();
      }

      // Last fallback to domain if nothing else
      if (!siteName) {
        siteName = new URL(url).hostname.replace('www.', '');
      }
    } catch (err) {
      console.warn(`Failed to fetch site name from ${url}:`, err.message);
      siteName = new URL(url).hostname.replace('www.', '');
    }

    if (!file) return res.status(400).json({ error: 'No screenshot uploaded' });

    const filename = `${file.filename}.png`;
    const filepath = path.join('uploads', filename);
    fs.renameSync(file.path, filepath);

    try {
      const report = await prisma.qAReport.create({
        data: {
          url,
          site: domain,
          slug: slugify(siteName, { lower: true }),
          siteName: siteName,
          comment,
          x: parseInt(x),
          y: parseInt(y),
          imagePath: `/uploads/${filename}`,
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
        image: `/uploads/${filename}`,
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
      where: { slug },
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
app.patch('/api/report/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const updated = await prisma.qAReport.update({
      where: { id },
      data: { status },
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

// src/app.js (after instantiating `prisma`)…

// Create a new comment with attachments for a report
app.post('/api/reports/:reportId/comments', async (req, res) => {
  const { reportId } = req.params;
  const { content, userId, attachments } = req.body;

  if (!reportId || !content) {
    return res.status(400).json({ error: 'reportId and content are required' });
  }

  try {
    const data = {
      content,
      reportId,
      attachments:
        attachments && attachments.length > 0
          ? {
              create: attachments.map((url) => ({ url })),
            }
          : undefined,
    };

    // Add userId only if provided
    if (userId) {
      data.userId = userId;
    }

    const comment = await prisma.comment.create({
      data,
      include: {
        attachments: true,
      },
    });

    res.json(comment);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: 'Unable to create comment with attachments' });
  }
});

// Retrieve comments with attachments for a report
app.get('/api/reports/:reportId/comments', async (req, res) => {
  const { reportId } = req.params;

  try {
    const comments = await prisma.comment.findMany({
      where: { reportId },
      include: {
        attachments: true,
        user: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(comments);
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

app.listen(PORT, () => {
  console.log(`QA backend running at http://localhost:${PORT}`);
});
