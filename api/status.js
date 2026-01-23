import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const dataDir = '/tmp';
  const hashFile = path.join(dataDir, 'prev_hash.txt');
  
  let lastCheck = 'Never';
  let status = 'waiting';
  
  try {
    if (fs.existsSync(hashFile)) {
      const stats = fs.statSync(hashFile);
      lastCheck = new Date(stats.mtime).toISOString();
      status = 'active';
    }
  } catch (e) {
    console.error(e);
  }
  
  return res.status(200).json({
    status,
    lastCheck,
    nextCheck: 'Every 6 hours'
  });
}