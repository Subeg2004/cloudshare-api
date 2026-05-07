// ===================================================================
// CloudShare API - Backend Server
// Author: Subeg Poudal (B00970131)
// Module: COM682 Cloud Native Development - CW2
// ===================================================================

// Load environment variables from .env file (must be first)
require('dotenv').config();

// Application Insights - must be set up before other requires for full instrumentation
const appInsights = require('applicationinsights');
if (process.env.APPINSIGHTS_CONNECTION_STRING) {
  appInsights.setup(process.env.APPINSIGHTS_CONNECTION_STRING)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true, true)
    .setSendLiveMetrics(true)
    .start();
  console.log('Application Insights enabled');
}
const telemetry = appInsights.defaultClient;

// Core dependencies
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { BlobServiceClient } = require('@azure/storage-blob');
const { CosmosClient } = require('@azure/cosmos');
const sql = require('mssql');

const cors = require('cors');

const app = express();

// CORS - must be first, before any route or other middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));


app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Multer for file uploads (in-memory, max 50MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ===================================================================
// AZURE CLIENTS
// ===================================================================

// Blob Storage
const blobServiceClient = BlobServiceClient.fromConnectionString(
  `DefaultEndpointsProtocol=https;AccountName=${process.env.STORAGE_ACCOUNT_NAME};AccountKey=${process.env.STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`
);
const containerClient = blobServiceClient.getContainerClient(process.env.CONTAINER_NAME);

// Cosmos DB
const cosmosClient = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const cosmosContainer = cosmosClient
  .database(process.env.COSMOS_DATABASE)
  .container(process.env.COSMOS_CONTAINER);

// SQL Database config
const sqlConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// Connect to SQL on startup; create users table if missing
let sqlPool;
async function initSql() {
  try {
    sqlPool = await sql.connect(sqlConfig);
    await sqlPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U')
      CREATE TABLE Users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        username NVARCHAR(100) NOT NULL UNIQUE,
        email NVARCHAR(255) NOT NULL UNIQUE,
        passwordHash NVARCHAR(255) NOT NULL,
        createdAt DATETIME DEFAULT GETUTCDATE()
      )
    `);
    console.log('SQL connected and Users table ready');
  } catch (err) {
    console.error('SQL connection failed:', err.message);
  }
}
initSql();

// ===================================================================
// AUTH MIDDLEWARE
// ===================================================================

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

function classifyFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) return 'photos';
  if (['mp4','mov','avi','mkv','webm','mp3','wav'].includes(ext)) return 'drive';
  if (['txt','md','doc','docx','pdf','rtf'].includes(ext)) return 'notes';
  return 'drive';
}

// ===================================================================
// HEALTH CHECK
// ===================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'CloudShare API is running',
    timestamp: new Date().toISOString(),
    services: {
      blobStorage: !!process.env.STORAGE_ACCOUNT_NAME,
      sqlDatabase: !!sqlPool,
      cosmosDb: !!process.env.COSMOS_CONNECTION_STRING,
      appInsights: !!process.env.APPINSIGHTS_CONNECTION_STRING
    }
  });
});

// ===================================================================
// AUTHENTICATION ENDPOINTS
// ===================================================================

// POST /api/signup - Create new user account
app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'Username, email, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    if (!sqlPool) await initSql();
    await sqlPool.request()
      .input('username', sql.NVarChar, username)
      .input('email', sql.NVarChar, email)
      .input('passwordHash', sql.NVarChar, passwordHash)
      .query('INSERT INTO Users (username, email, passwordHash) VALUES (@username, @email, @passwordHash)');

    if (telemetry) telemetry.trackEvent({ name: 'UserSignup', properties: { username } });
    res.json({ success: true, message: 'Account created successfully' });
  } catch (err) {
    if (err.number === 2627 || err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: 'Username or email already exists' });
    }
    console.error('Signup error:', err);
    if (telemetry) telemetry.trackException({ exception: err });
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/login - Authenticate user, return JWT
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    if (!sqlPool) await initSql();
    const result = await sqlPool.request()
      .input('email', sql.NVarChar, email)
      .query('SELECT id, username, email, passwordHash FROM Users WHERE email = @email');

    if (result.recordset.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const user = result.recordset[0];
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id.toString(), username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    if (telemetry) telemetry.trackEvent({ name: 'UserLogin', properties: { username: user.username } });
    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, email: user.email }
    });
  } catch (err) {
    console.error('Login error:', err);
    if (telemetry) telemetry.trackException({ exception: err });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================================================================
// FILE CRUD ENDPOINTS (all require auth)
// ===================================================================

// POST /api/upload - Upload a file (multipart/form-data)
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }
    const userId = req.user.userId;
    const originalName = req.file.originalname;
    const blobName = `${userId}/${Date.now()}-${originalName}`;
    const category = classifyFile(originalName);

    // Upload to Blob Storage
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(req.file.buffer, req.file.size, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype }
    });

    // Save metadata to Cosmos DB
    const metadata = {
      id: blobName.replace(/\//g, '_'),
      userId,
      blobName,
      originalName,
      contentType: req.file.mimetype,
      size: req.file.size,
      category,
      blobUrl: blockBlobClient.url,
      uploadedAt: new Date().toISOString()
    };
    await cosmosContainer.items.create(metadata);

    if (telemetry) telemetry.trackEvent({
      name: 'FileUpload',
      properties: { userId, category, contentType: req.file.mimetype },
      measurements: { fileSizeBytes: req.file.size }
    });

    res.json({ success: true, file: metadata });
  } catch (err) {
    console.error('Upload error:', err);
    if (telemetry) telemetry.trackException({ exception: err });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/media - List current user's files (optional ?category=photos|drive|notes)
app.get('/api/media', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { category } = req.query;

    let query = 'SELECT * FROM c WHERE c.userId = @userId';
    const parameters = [{ name: '@userId', value: userId }];
    if (category) {
      query += ' AND c.category = @category';
      parameters.push({ name: '@category', value: category });
    }
    query += ' ORDER BY c.uploadedAt DESC';

    const { resources } = await cosmosContainer.items.query({ query, parameters }).fetchAll();
    res.json({ success: true, files: resources, count: resources.length });
  } catch (err) {
    console.error('List error:', err);
    if (telemetry) telemetry.trackException({ exception: err });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/stats - User storage stats (used by the dashboard)
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { resources } = await cosmosContainer.items.query({
      query: 'SELECT * FROM c WHERE c.userId = @userId',
      parameters: [{ name: '@userId', value: userId }]
    }).fetchAll();

    const totalSize = resources.reduce((sum, f) => sum + (f.size || 0), 0);
    const byCategory = { photos: 0, drive: 0, notes: 0 };
    resources.forEach(f => { if (byCategory[f.category] !== undefined) byCategory[f.category]++; });

    res.json({
      success: true,
      stats: {
        totalFiles: resources.length,
        totalSizeBytes: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        storageQuotaMB: 1024,
        byCategory,
        lastUpload: resources[0] ? resources[0].uploadedAt : null
      }
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/media/:id - Rename a file
app.put('/api/media/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { newName } = req.body;

    if (!newName) return res.status(400).json({ success: false, error: 'newName required' });

    const { resource: existing } = await cosmosContainer.item(id, userId).read();
    if (!existing) return res.status(404).json({ success: false, error: 'File not found' });

    existing.originalName = newName;
    await cosmosContainer.item(id, userId).replace(existing);

    if (telemetry) telemetry.trackEvent({ name: 'FileRename', properties: { userId } });
    res.json({ success: true, file: existing });
  } catch (err) {
    console.error('Rename error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/media/:id - Delete a file (removes from blob + cosmos)
app.delete('/api/media/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const { resource: existing } = await cosmosContainer.item(id, userId).read();
    if (!existing) return res.status(404).json({ success: false, error: 'File not found' });

    await containerClient.getBlockBlobClient(existing.blobName).deleteIfExists();
    await cosmosContainer.item(id, userId).delete();

    if (telemetry) telemetry.trackEvent({ name: 'FileDelete', properties: { userId } });
    res.json({ success: true, message: 'File deleted' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================================================================
// START SERVER
// ===================================================================

const PORT = process.env.FUNCTIONS_CUSTOMHANDLER_PORT || process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CloudShare API listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});