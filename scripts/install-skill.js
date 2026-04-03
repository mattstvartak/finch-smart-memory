#!/usr/bin/env node

/**
 * Install openclaw-smart-memory as an OpenClaw workspace skill.
 *
 * Usage: node scripts/install-skill.js
 *
 * Creates a symlink from ~/.openclaw/workspace/skills/smart-memory
 * to this project directory.
 */

import { symlinkSync, existsSync, mkdirSync, readlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const home = homedir();
const skillsDir = join(home, '.openclaw', 'workspace', 'skills');
const targetDir = resolve(import.meta.dirname, '..');
const linkPath = join(skillsDir, 'smart-memory');

// Ensure skills directory exists
if (!existsSync(skillsDir)) {
  mkdirSync(skillsDir, { recursive: true });
  console.log(`Created ${skillsDir}`);
}

// Check if link already exists
if (existsSync(linkPath)) {
  try {
    const existing = readlinkSync(linkPath);
    if (resolve(existing) === targetDir) {
      console.log(`Already installed: ${linkPath} -> ${targetDir}`);
      process.exit(0);
    }
    // Remove stale link
    unlinkSync(linkPath);
  } catch {
    console.error(`${linkPath} exists but is not a symlink. Remove it manually.`);
    process.exit(1);
  }
}

try {
  symlinkSync(targetDir, linkPath, 'junction');
  console.log(`Installed: ${linkPath} -> ${targetDir}`);
  console.log('\nNext steps:');
  console.log('  1. Set OPENROUTER_API_KEY in your environment');
  console.log('  2. Run: npm run build');
  console.log('  3. Test: npm run stats');
} catch (err) {
  console.error(`Failed to create symlink: ${err.message}`);
  console.error('On Windows, you may need to run as Administrator or enable Developer Mode.');
  process.exit(1);
}
