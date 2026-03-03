const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTO_DELETE_MS = 10 * 60 * 1000; // 10 minutes

// In production, replace this Map with Cloudflare R2 or S3
const fileStore = new Map();
// Structure: fileId -> { buffer, name, size, mimeType, meetCode, uploadedAt, timer }

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests from chrome-extension://, edge-extension://, and meet.google.com
    if (
      !origin ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://') ||
      origin === 'https://meet.google.com'
    ) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'DELETE']
}));
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// --- Health check ---
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'meet-file-share-backend' });
});

// --- Upload endpoint ---
app.post('/upload', upload.single('file'), (req, res) => {
  const { meetCode } = req.body;
  if (!req.file || !meetCode) {
    return res.status(400).json({ error: 'Missing file or meetCode' });
  }

  const fileId = uuidv4();
  const timer = setTimeout(() => {
    fileStore.delete(fileId);
    console.log(`Auto-deleted: ${fileId}`);
  }, AUTO_DELETE_MS);

  fileStore.set(fileId, {
    buffer: req.file.buffer,
    name: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype,
    meetCode,
    uploadedAt: Date.now(),
    timer
  });

  res.json({ fileId, fileName: req.file.originalname, fileSize: req.file.size });
});

// --- Poll for new files in a meeting ---
app.get('/poll/:meetCode', (req, res) => {
  const { meetCode } = req.params;
  const { since } = req.query; // timestamp
  const sinceMs = parseInt(since) || 0;

  const files = [];
  for (const [fileId, meta] of fileStore.entries()) {
    if (meta.meetCode === meetCode && meta.uploadedAt > sinceMs) {
      files.push({
        fileId,
        fileName: meta.name,
        fileSize: meta.size,
        uploadedAt: meta.uploadedAt
      });
    }
  }
  res.json({ files });
});

// --- Download endpoint ---
app.get('/download/:fileId', (req, res) => {
  const meta = fileStore.get(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'File not found or expired' });

  res.setHeader('Content-Disposition', `attachment; filename="${meta.name}"`);
  res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', meta.size);
  res.send(meta.buffer);
});

// --- Manual delete endpoint ---
app.delete('/delete/:fileId', (req, res) => {
  const meta = fileStore.get(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'Not found' });

  clearTimeout(meta.timer);
  fileStore.delete(req.params.fileId);
  res.json({ deleted: true });
});

app.listen(PORT, () => console.log(`MFS backend running on port ${PORT}`));
