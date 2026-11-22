import express from 'express';
import { spawn, spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { requireAdmin, type AuthedRequest } from '../middleware.ts';
import { writeAuditLog } from '../security.ts';
import { cleanupNow } from '../services/serverCleanup.ts';

type DeployState = 'idle' | 'running' | 'success' | 'error';

export interface DeployJob {
  startedAt: string;
  finishedAt?: string;
  state: DeployState;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

const DEPLOY_ROOT = 'C:/PositiveVector';

export function createDeployRouter(db: DatabaseSync): express.Router {
  const router = express.Router();
  let activeJob: DeployJob | null = null;

  router.get('/status', requireAdmin, (_req, res) => {
    res.json({
      busy: activeJob?.state === 'running',
      lastJob: activeJob,
    });
  });

  router.post('/from-git', requireAdmin, (req: AuthedRequest, res) => {
    if (activeJob?.state === 'running') {
      res.status(409).json({ ok: false, error: 'Deploy already in progress' });
      return;
    }

    const now = new Date().toISOString();
    activeJob = {
      startedAt: now,
      state: 'running',
      stdout: '',
      stderr: '',
    };

    writeAuditLog(db, req.authUser!.id, 'deploy', 'git', 'deploy_from_git_started', {
      at: now,
    });

    const child = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `
$ErrorActionPreference = 'Stop'
Set-Location ${DEPLOY_ROOT}

Write-Host '=== Cleaning up caches and old backups ==='
& node -e "const {cleanupNow} = require('./server/services/serverCleanup.ts'); const r = cleanupNow(${JSON.stringify(DEPLOY_ROOT)}); console.log('removed', r.removed.length, 'errors', r.errors.length);" || Write-Host 'cleanup step reported errors, continuing'

Write-Host '=== Git pull ==='
git pull origin master

Write-Host '=== Restore node_modules ==='
if (Test-Path .\\node_modules) { Remove-Item -Recurse -Force .\\node_modules }
npm ci

Write-Host '=== Build ==='
npm run build

Write-Host '=== Test ==='
npm test

Write-Host '=== Restart service ==='
schtasks /run /tn CRM-Auto-Start
`,
    ], {
      cwd: DEPLOY_ROOT,
      shell: false,
      env: process.env,
    });

    child.stdout.on('data', (d: Buffer) => {
      activeJob!.stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      activeJob!.stderr += d.toString();
    });
    child.on('close', (code) => {
      activeJob!.state = code === 0 ? 'success' : 'error';
      activeJob!.finishedAt = new Date().toISOString();
      activeJob!.exitCode = code ?? -1;
      writeAuditLog(db, req.authUser!.id, 'deploy', 'git', 'deploy_from_git_finished', {
        exitCode: code,
        at: activeJob!.finishedAt,
      });
    });
    child.on('error', (err) => {
      activeJob!.state = 'error';
      activeJob!.finishedAt = new Date().toISOString();
      activeJob!.stderr += `\n${err.message}`;
      writeAuditLog(db, req.authUser!.id, 'deploy', 'git', 'deploy_from_git_error', {
        error: err.message,
        at: activeJob!.finishedAt,
      });
    });

    res.json({ ok: true, started: true });
  });

  return router;
}
