const path = require('path');
const fs = require('fs-extra');
const { logEvent } = require('./logger');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

/**
 * Move processed file to FATURADO/YYYY-MM folder
 */
async function moveToFaturado(filename, month, fileId = null) {
  try {
    const sourcePath = path.join(UPLOAD_DIR, 'pending', filename);
    const monthFolder = path.join(UPLOAD_DIR, 'faturado', month);
    
    await fs.ensureDir(monthFolder);
    
    const destPath = path.join(monthFolder, filename);
    await fs.move(sourcePath, destPath, { overwrite: false });
    
    await logEvent('info', 'system', `File moved to FATURADO/${month}: ${filename}`, null, fileId);
    return destPath;
  } catch (error) {
    await logEvent('error', 'system', `Failed to move file: ${error.message}`, null, fileId);
    // Don't throw - file movement failure shouldn't block contract creation
    return null;
  }
}

/**
 * Get upload path for new file
 */
function getPendingPath(filename) {
  return path.join(UPLOAD_DIR, 'pending', filename);
}

/**
 * List files in pending folder
 */
async function listPending() {
  const pendingDir = path.join(UPLOAD_DIR, 'pending');
  await fs.ensureDir(pendingDir);
  const files = await fs.readdir(pendingDir);
  return files.filter(f => f.endsWith('.pdf'));
}

/**
 * List files in faturado folder by month
 */
async function listFaturado(month = null) {
  const faturadoDir = path.join(UPLOAD_DIR, 'faturado');
  await fs.ensureDir(faturadoDir);
  
  if (month) {
    const monthDir = path.join(faturadoDir, month);
    if (!await fs.pathExists(monthDir)) return [];
    return await fs.readdir(monthDir);
  }
  
  const months = await fs.readdir(faturadoDir);
  const result = {};
  for (const m of months) {
    const files = await fs.readdir(path.join(faturadoDir, m));
    result[m] = files.filter(f => f.endsWith('.pdf'));
  }
  return result;
}

module.exports = { moveToFaturado, getPendingPath, listPending, listFaturado };
