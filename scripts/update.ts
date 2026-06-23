#!/usr/bin/env bun
/**
 * update.ts — bring an installed ira-memory up to date: pull, deps, migrate, restart, health-check.
 *
 *   bun run update            # or: bun run scripts/update.ts
 *   bun run update -- --dry-run
 *
 * Best-effort + idempotent. Restarts the managed service (systemd ira-memory-api on Linux /
 * launchd com.ira.ira-memory-api on macOS); prints a hint if no managed unit is found.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';

const REPO = resolve(import.meta.dir, '..');
const OS: 'darwin' | 'linux' | 'other' =
  process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'other';
const DRY = process.argv.includes('--dry-run');
const PORT = Number(process.env.MEMORY_API_PORT ?? 7775);

const log = (tag: string, msg: string) => console.log(`  ${DRY ? '[dry] ' : ''}${tag.padEnd(9)} ${msg}`);
const die = (msg: string): never => { console.error(`\n✗ ${msg}`); process.exit(1); };

function run(cmd: string, args: string[]): SpawnSyncReturns<string> {
  if (DRY) { log('RUN', `${cmd} ${args.join(' ')}`); return { status: 0 } as any; }
  return spawnSync(cmd, args, { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'inherit', 'inherit'] });
}
const cap = (cmd: string, args: string[]) =>
  (spawnSync(cmd, args, { cwd: REPO, encoding: 'utf-8' }).stdout || '').trim();

console.log(`\n=== ira-memory update (${OS}${DRY ? ', dry-run' : ''}) ===`);
log('REPO', REPO);

// Dirty tracked files block a fast-forward pull.
const dirty = cap('git', ['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean);
if (dirty.length) die(`uncommitted tracked changes — commit/stash first:\n${dirty.map((d) => '    ' + d).join('\n')}`);

const before = cap('git', ['rev-parse', '--short', 'HEAD']);
if (run('git', ['pull', '--ff-only']).status !== 0) die('git pull failed (diverged history?). Resolve manually and re-run.');
log('PULL', `${before} → ${cap('git', ['rev-parse', '--short', 'HEAD'])}`);

run('bun', ['install']);
log('DEPS', 'bun install');

run('bunx', ['prisma', 'generate']);
const mig = run('bunx', ['prisma', 'migrate', 'deploy']);
log('DB', mig.status === 0 ? 'prisma migrate deploy' : `⚠️ migrate exited ${mig.status} — is the DB up? (docker compose up -d)`);

// Restart the managed service so it picks up the new code + .env.
if (DRY) log('RESTART', 'ira-memory-api');
else if (OS === 'linux' && spawnSync('systemctl', ['--user', 'restart', 'ira-memory-api.service'], { encoding: 'utf-8' }).status === 0)
  log('RESTART', 'ira-memory-api (systemd)');
else if (OS === 'darwin' && spawnSync('launchctl', ['kickstart', '-k', `gui/${userInfo().uid}/com.ira.ira-memory-api`], { encoding: 'utf-8' }).status === 0)
  log('RESTART', 'ira-memory-api (launchd)');
else log('RESTART', '⚠️ no managed unit found — restart the memory API manually (bun run memory-api)');

// Health check (best-effort; /health doesn't touch the DB, so also try a DB-backed endpoint).
if (!DRY) {
  const probe = (path: string) => spawnSync('curl', ['-s', '--max-time', '4', `http://127.0.0.1:${PORT}${path}`], { encoding: 'utf-8' });
  const ok = /"?status"?\s*:?\s*"?ok/i.test(probe('/health').stdout || '');
  log('HEALTH', ok ? '✓ up' : '⚠️ no response yet — it may still be starting (re-check in a few seconds)');
}
console.log(`\n✓ ira-memory updated.${DRY ? ' (dry-run — nothing changed)' : ''}\n`);
