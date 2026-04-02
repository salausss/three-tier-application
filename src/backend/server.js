'use strict';

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database Pool ─────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'postgres-service',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'taskflow',
  user:     process.env.DB_USER     || 'taskflow',
  password: process.env.DB_PASSWORD || 'changeme',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

// ── Init DB Schema ────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(120) NOT NULL,
        status      VARCHAR(20)  NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo', 'progress', 'done')),
        priority    VARCHAR(10)  NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('low', 'medium', 'high')),
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    // seed a few starter tasks if table is empty
    const { rows } = await client.query('SELECT COUNT(*) FROM tasks');
    if (parseInt(rows[0].count) === 0) {
      await client.query(`
        INSERT INTO tasks (title, status, priority) VALUES
          ('Set up EKS cluster with Terraform',   'done',     'high'),
          ('Configure ALB Ingress Controller',    'done',     'high'),
          ('Set up ACM SSL certificate',          'progress', 'high'),
          ('Integrate RDS with backend',          'progress', 'medium'),
          ('Add HPA for backend pods',            'todo',     'medium'),
          ('Write deployment runbook',            'todo',     'low');
      `);
      console.log('Seeded initial tasks.');
    }
    console.log('Database schema ready.');
  } finally {
    client.release();
  }
}

// ── Middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────

// Health check — used by K8s liveness/readiness probes
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// GET all tasks (ordered: priority desc, newest first)
app.get('/api/tasks', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM tasks
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /tasks error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// GET single task
app.get('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
  try {
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// POST create task
app.post('/api/tasks', async (req, res) => {
  const { title, priority = 'medium' } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const validPriorities = ['low', 'medium', 'high'];
  if (!validPriorities.includes(priority)) {
    return res.status(400).json({ error: 'priority must be low | medium | high' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, priority) VALUES ($1, $2) RETURNING *`,
      [title.trim().slice(0, 120), priority]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /tasks error:', err.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH update task status (or priority)
app.patch('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });

  const { status, priority } = req.body;
  const validStatuses = ['todo', 'progress', 'done'];
  const validPriorities = ['low', 'medium', 'high'];

  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'status must be todo | progress | done' });
  }
  if (priority && !validPriorities.includes(priority)) {
    return res.status(400).json({ error: 'priority must be low | medium | high' });
  }

  try {
    const updates = [];
    const values = [];
    let idx = 1;

    if (status)   { updates.push(`status = $${idx++}`);   values.push(status); }
    if (priority) { updates.push(`priority = $${idx++}`); values.push(priority); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const { rows } = await pool.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /tasks error:', err.message);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// DELETE task
app.delete('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Task not found' });
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /tasks error:', err.message);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────
async function start() {
  let retries = 10;
  while (retries > 0) {
    try {
      await initDB();
      break;
    } catch (err) {
      retries--;
      console.warn(`DB not ready, retrying... (${retries} left): ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (retries === 0) {
    console.error('Could not connect to database. Exiting.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TaskFlow API running on port ${PORT}`);
    console.log(`DB: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  });
}

start();
