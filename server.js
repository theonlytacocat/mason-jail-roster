// v2
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import PDFParser from 'pdf-parse';
import {
  parseBookingDate,
  formatMinutes,
  parseTimeServed,
  daysBetween,
  isMidnight,
  formatDatePST
} from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use('/fonts', express.static(path.join(__dirname, 'fonts')));
const PORT = process.env.PORT || 3000;
const PDF_URL = 'https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf';
const RELEASE_STATS_URL = 'https://hub.masoncountywa.gov/sheriff/reports/release_stats48hrs.pdf';
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const RELEASE_STATS_HISTORY_FILE = path.join(STORAGE_DIR, 'release_stats_history.json');

// Ensure storage directory exists
function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}
ensureStorageDir();
async function fetchReleaseStats() {
  try {
    const response = await fetch(RELEASE_STATS_URL);
    if (!response.ok) return new Map();
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;
    
    const releaseMap = new Map();
    const lines = result.text.split('\n').map(l => l.trim()).filter(l => l);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Look for lines starting with date/time
      const dateMatch = line.match(/^(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})(.*)$/);
      if (!dateMatch) continue;
      
      const date = dateMatch[1];
      const time = dateMatch[2];
      let rest = dateMatch[3].trim();
      
      // Accumulate subsequent lines that are part of this record
      let fullText = rest;
      let j = i + 1;
      
      // Keep adding lines until we hit another date or run out
      while (j < lines.length && !/^\d{2}\/\d{2}\/\d{2}/.test(lines[j])) {
        fullText += ' ' + lines[j];
        j++;
      }
      
      // Now parse the complete record
      // Pattern: NAME RELEASE_TYPE TIME_SERVED BAIL
      // Example: "BARNACASCEL, LEON D.RNF3 d 3 h 27 m$0.00"
      // Example: "HILARIO GARCIA, JESSICA G. RPR 0 d 23 h 9 m $0.00"
      
      const recordMatch = fullText.match(/^(.+?)\s*([A-Z]{2,5})\s*(\d+\s*d\s*\d+\s*h\s*\d+\s*m)\s*\$?([\d,]+\.\d{2})/);
      
      if (recordMatch) {
        const rawName = recordMatch[1];
        const releaseType = recordMatch[2];
        const timeServed = recordMatch[3];
        const bail = recordMatch[4];
        
        // Clean up name
        const cleanName = rawName.trim()
          .replace(/\s+/g, ' ')
          .replace(/\.\s*$/, '')
          .replace(/\s*\.\s*$/, '');
        
        releaseMap.set(cleanName, {
          releaseDateTime: `${date} ${time}`,
          releaseType,
          timeServed: timeServed.replace(/\s+/g, ''),
          bail: `$${bail}`
        });
        
        // Skip the lines we consumed
        i = j - 1;
      }
    }
    
    console.log(`✓ Parsed ${releaseMap.size} releases from PDF`);
    
    // Save new entries to history file (dedup by name+releaseDateTime)
    try {
      let history = [];
      if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8'));
      }
      const existingKeys = new Set(history.map(e => e.name + '|' + e.releaseDateTime));
      let newCount = 0;
      for (const [name, info] of releaseMap.entries()) {
        const key = name + '|' + info.releaseDateTime;
        if (!existingKeys.has(key)) {
          history.push({ name, ...info });
          existingKeys.add(key);
          newCount++;
        }
      }
      if (newCount > 0) {
        fs.writeFileSync(RELEASE_STATS_HISTORY_FILE, JSON.stringify(history, null, 2));
        console.log(`✓ Saved ${newCount} new releases to history (total: ${history.length})`);
      }
    } catch (e) {
      console.error('Error saving release stats history:', e);
    }

    return releaseMap;
  } catch (error) {
    console.error('Error fetching release stats:', error);
    return new Map();
  }
}

// Extract bookings from roster text
function extractBookings(rosterText) {
  const bookings = new Map();
  const blocks = rosterText.split(/(?=Booking #:)/);

  for (const block of blocks) {
    if (!block.includes("Booking #:")) continue;

    const bookingMatch = block.match(/Booking #:\s*(\S+)/);
    if (!bookingMatch) continue;
    const id = bookingMatch[1];

    const nameMatch = block.match(/Name:\s*([A-Z][A-Z\s,.'"-]+?)(?=\s*Name Number:|$)/i);
    let name = nameMatch ? nameMatch[1].trim().replace(/\s+/g, " ") : "Unknown";
    if (name.endsWith(",")) {
      const nextLine = block.match(/Name:\s*[^\n]+\n([A-Z][A-Z\s'-]*)/i);
      if (nextLine) name = name + " " + nextLine[1].trim();
    }

    const bookDateMatch = block.match(/Book Date:\s*(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const bookDate = bookDateMatch ? bookDateMatch[2] + " " + bookDateMatch[1] : "Unknown";

    const relDateMatch = block.match(/Rel Date:\s*(?:No Rel Date|(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))/);
    let releaseDate = "Not Released";
    if (relDateMatch && relDateMatch[1] && relDateMatch[2]) {
      releaseDate = relDateMatch[2] + " " + relDateMatch[1];
    }

    const charges = [];
    const lines = block.split("\n");
    let inCharges = false;
    
    for (const line of lines) {
      const t = line.trim();
      
      // Start capturing after header (flexible matching)
      if (t.includes("StatuteOffense") || (t.includes("Statute") && t.includes("Offense"))) {
        inCharges = true;
        continue;
      }
      
      // If we're in charges section and line has content
      if (inCharges && t.length > 0) {
        // Skip header lines and page markers
        if (t.includes("Name Number:") || t.includes("Book Date:") || 
            t.includes("Rel Date:") || t.includes("Page ") || 
            t.includes("rpjlciol") || t.includes("Current Inmate") ||
            t.includes("StatuteOffense")) {
          continue;
        }
        
        // Look for lines that contain court types
        if (t.includes('SUPR') || t.includes('DIST') || t.includes('MUNI') || t.includes('DOC')) {
          // Remove statute code at the beginning (numbers, dots, letters in parentheses)
          let cleaned = t.replace(/^[\d.()A-Z]+(?=[A-Z][a-z])/, '');
          
          // Remove everything from the court type onwards
          cleaned = cleaned.replace(/(SUPR|DIST|MUNI|DOC).*$/, '');
          
          // What's left should be the offense name
          cleaned = cleaned.trim();
          
          if (cleaned.length > 2) {
            charges.push(cleaned);
          }
        }
      }
    }
    bookings.set(id, {
      id,
      name,
      bookDate,
      releaseDate,
      charges: [...new Set(charges)]
    });
  }
  return bookings;
}

// Format functions
function formatBooked(b) {
  const chargeText = b.charges && b.charges.length > 0 ? b.charges.join(", ") : "None listed";
  return b.name + " | Booked: " + b.bookDate + " | Charges: " + chargeText;
}
function formatReleased(b, stats, isPending = false) {
  const chargeText = b.charges && b.charges.length > 0 ? b.charges.join(", ") : "None listed";
  const releaseInfo = stats.get(b.name);
  if (releaseInfo) {
    const bailAmount = parseFloat(releaseInfo.bail.replace(/[$,]/g, ''));
    const bailText = bailAmount > 0 ? " | Bail Posted: " + releaseInfo.bail : "";
    
    return {
      text: b.name + " | Released: " + releaseInfo.releaseDateTime + 
            " | Time served: " + releaseInfo.timeServed + 
            bailText +
            " (" + releaseInfo.releaseType + ")" +
            " | Charges: " + chargeText,
      hasPendingDetails: false
    };
  }
  
  // No detailed release info available - use current date/time as detection time
  const now = new Date();
  const releaseDate = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${String(now.getFullYear()).slice(-2)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  
  return {
    text: b.name + " | Released: " + releaseDate + " | Charges: " + chargeText,
    hasPendingDetails: false
  };
}

// Fixing the release counter for accurate contexttt
app.get('/api/admin/fix-releases', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    
    let fixed = 0;
    let currentDate = null;
    const fixedLines = [];
    
    for (const line of lines) {
      // Track the current date context from ANY dated entry (BOOKED or RELEASED with valid dates)
      const dateMatch = line.match(/(?:Booked|Released):\s+(\d{2}\/\d{2}\/\d{2})\s+\d{2}:\d{2}:\d{2}/);
      if (dateMatch) {
        currentDate = dateMatch[1];
      }
      
      // Also check for release dates without times (like "Released: 02/09/26")
      const releaseDateOnlyMatch = line.match(/Released:\s+(\d{2}\/\d{2}\/\d{2})(?:\s|$|\|)/);
      if (releaseDateOnlyMatch && !line.includes('00:00:00')) {
        currentDate = releaseDateOnlyMatch[1];
      }
      
      // Fix broken RELEASED entries
      if (line.includes('RELEASED |') && line.includes('Released: Not Released')) {
        if (currentDate) {
          // Replace "Released: Not Released" with "Released: DATE 00:00:00"
          const fixedLine = line.replace('Released: Not Released', `Released: ${currentDate} 00:00:00`);
          fixedLines.push(fixedLine);
          fixed++;
        } else {
          // No date context available, keep the line as-is
          fixedLines.push(line);
        }
      } else {
        fixedLines.push(line);
      }
    }
    
    // Backup original
    fs.writeFileSync(logFile + '.backup-' + Date.now(), content);
    
    // Write fixed version
    fs.writeFileSync(logFile, fixedLines.join('\n'));
    
    res.json({
      success: true,
      fixed: fixed,
      message: `Fixed ${fixed} release entries. Original backed up.`
    });
    
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// this is where im putting the release stats debug endpoint
app.get('/api/debug/release-pdf-raw', async (req, res) => {
  try {
    const response = await fetch(RELEASE_STATS_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    
    // Get first 3000 characters of raw text
    const sample = result.text.substring(0, 3000);
    
    // Also try to parse and show what we get
    const lines = result.text.split('\n');
    const relevantLines = [];
    
    for (let i = 0; i < Math.min(50, lines.length); i++) {
      const line = lines[i];
      if (line.trim()) {
        relevantLines.push({
          index: i,
          text: line,
          length: line.length,
          startsWithDate: /^\d{2}\/\d{2}\/\d{2}/.test(line)
        });
      }
    }
    
    res.json({
      rawSample: sample,
      relevantLines: relevantLines
    });
    
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/debug/reset', (req, res) => {
  try {
    const hashFile = path.join(STORAGE_DIR, 'prev_hash.txt');
    const rosterFile = path.join(STORAGE_DIR, 'prev_roster.txt');
    
    let deleted = [];
    
    if (fs.existsSync(hashFile)) {
      fs.unlinkSync(hashFile);
      deleted.push('prev_hash.txt');
    }
    
    if (fs.existsSync(rosterFile)) {
      fs.unlinkSync(rosterFile);
      deleted.push('prev_roster.txt');
    }
    
    res.json({
      success: true,
      deleted: deleted,
      message: 'Files deleted. Now visit /api/run to capture current roster with charges.'
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug Log Tail endpoint
app.get('/api/debug/log-tail', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      // Get last 5000 characters
      const tail = content.slice(-5000);
      res.setHeader('Content-Type', 'text/plain');
      res.send(tail);
    } else {
      res.send('No log file found');
    }
  } catch (error) {
    res.send('Error: ' + error.message);
  }
});

// Changelog endpoint for frontend
app.get('/api/changelog', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      res.json({ success: true, log: content });
    } else {
      res.json({ success: true, log: '' });
    }
  } catch (error) {
    console.error('Changelog error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug charges enpoint I think 
app.get('/api/debug/charges', async (req, res) => {
  try {
    const response = await fetch(PDF_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;
    
    const bookings = extractBookings(text);
    const sample = Array.from(bookings.values()).slice(0, 10).map(b => ({
      name: b.name,
      bookDate: b.bookDate,
      releaseDate: b.releaseDate,
      charges: b.charges
    }));
    
    res.json({
      totalInmates: bookings.size,
      sample: sample
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug endpoint to see parsed PDF text
app.get('/api/debug', async (req, res) => {
  try {
    const response = await fetch(PDF_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;
    
    // Get first 3000 characters
    const sample = text.substring(0, 3000);
    
    res.setHeader('Content-Type', 'text/plain');
    res.send(sample);
  } catch (error) {
    res.send('Error: ' + error.message);
  }
});

// Debug endpoint to see what files are in storage
app.get('/api/debug/files', (req, res) => {
  try {
    const files = fs.readdirSync(STORAGE_DIR);
    const fileDetails = files.map(f => {
      const stats = fs.statSync(path.join(STORAGE_DIR, f));
      return {
        name: f,
        size: stats.size,
        modified: stats.mtime
      };
    });
    res.json({ 
      storageDir: STORAGE_DIR,
      files: fileDetails 
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug endpoint to see pending releases
app.get('/api/debug/pending', (req, res) => {
  try {
    const pendingFile = path.join(STORAGE_DIR, 'pending_releases.json');
    if (fs.existsSync(pendingFile)) {
      const data = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
      res.json({ 
        count: data.length,
        pendingReleases: data 
      });
    } else {
      res.json({ message: 'No pending releases file found' });
    }
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug endpoint to see release stats
app.get('/api/debug/release-stats', async (req, res) => {
  try {
    const releaseStats = await fetchReleaseStats();
    res.json({
      count: releaseStats.size,
      sample: Array.from(releaseStats.entries()).slice(0, 10)
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

  app.get('/api/debug/charge-lines', async (req, res) => {
    try {
    const response = await fetch(PDF_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;
    
    const blocks = text.split(/(?=Booking #:)/);
    const firstBlock = blocks.find(b => b.includes("Booking #:"));
    
    if (!firstBlock) {
      return res.json({ error: 'No booking blocks found' });
    }
    
    const lines = firstBlock.split("\n");
    const relevantLines = [];
    
    // Get 30 lines to see what's happening
    for (let i = 0; i < Math.min(30, lines.length); i++) {
      const t = lines[i].trim();
      relevantLines.push({
        index: i,
        text: t,
        length: t.length,
        includesStatute: t.includes("Statute"),
        includesOffense: t.includes("Offense"),
        exactMatch: t === "StatuteOffenseCourtOffenseClass"
      });
    }
    
    res.json({ relevantLines });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Redirect root to status
app.get('/', (req, res) => {
  res.redirect('/api/status');
});

// Status page
app.get('/api/status', (req, res) => {
  const dataDir = STORAGE_DIR;
  let lastCheck = "Never";
  let inmateCount = 0;
  let changeCount = 0;
  let viewCount = 0;

  try {
    const hashFile = path.join(dataDir, "prev_hash.txt");
    if (fs.existsSync(hashFile)) {
      const stats = fs.statSync(hashFile);
      lastCheck = stats.mtime.toISOString();
    }

    const rosterFile = path.join(dataDir, "prev_roster.txt");
    if (fs.existsSync(rosterFile)) {
      const content = fs.readFileSync(rosterFile, "utf-8");
      const bookingMatches = content.match(/Booking #:/g);
      inmateCount = bookingMatches ? bookingMatches.length : 0;
    }

    const logFile = path.join(dataDir, "change_log.txt");
if (fs.existsSync(logFile)) {
  const content = fs.readFileSync(logFile, "utf-8");
  // Count BOOKED and RELEASED entries
  const bookedCount = (content.match(/^BOOKED \|/gm) || []).length;
  const releasedCount = (content.match(/^RELEASED \|/gm) || []).length;
  changeCount = bookedCount + releasedCount;
}

    const metricsFile = path.join(dataDir, "metrics.json");
    let metrics = { statusViews: 0, historyViews: 0, emailViews: 0 };

    if (fs.existsSync(metricsFile)) {
      try {
        metrics = JSON.parse(fs.readFileSync(metricsFile, "utf-8"));
      } catch (e) {}
    }
    metrics.statusViews = (metrics.statusViews || 0) + 1;
    viewCount = metrics.statusViews;

    try {
      fs.writeFileSync(metricsFile, JSON.stringify(metrics));
    } catch (e) {
      console.error("Failed to write metrics:", e);
    }
  } catch (e) {}

  const html = `<!DOCTYPE html>
<html>
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D2LNWC78X7"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-D2LNWC78X7');
</script>

  <title>Mason County Jail Roster Monitor</title>
  <!-- build:9b75fde -->
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { overflow-x: hidden; width: 100%; }
    body { font-family: Arial, sans-serif; font-size: 8pt; background: #191D18; color: #ffffff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 0.5rem; }
    .container { width: 100%; max-width: 500px; padding: 1rem; }
    h1 { font-family: 'Pixel Digivolve', 'Courier New', monospace; font-size: 2rem; margin-bottom: 1.5rem; color: #E5DDD0; letter-spacing: -1px; overflow: hidden; white-space: nowrap; }
    h1 span { display: inline-block; animation: ticker 15s linear infinite; }
    @keyframes ticker { 0% { transform: translateX(100%); } 100% { transform: translateX(-100%); } }
    .status { background: #222C22; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; }
    .status-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
    .status-dot { width: 12px; height: 12px; background: #22C55E; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .status-title { font-weight: 600; }
    .stats { display: grid; gap: 1rem; }
    .stat { display: flex; justify-content: space-between; padding: 0.75rem 0; border-bottom: 1px solid #283C2A; }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #FFFFFF; }
    .stat-value { font-weight: 500; }
    .run-btn { display: block; width: 100%; padding: 0.75rem; margin-top: 1rem; background: #2A3828; color: #fff; text-align: center; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .run-btn:hover { background: #3A4E38; }
    .footer { text-align: center; color: #72807A; font-size: 0.875rem; margin-top: 1.5rem; }
    a { color: #C1B09A; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1><span>Mason County Jail Roster Monitor</span></h1>
    <a href="/api/history" class="run-btn">Jail Bookings and Release Log</a>
    <a href="/api/stats" class="run-btn" style="margin-top: 0.75rem;">Statistics Dashboard</a>
    <a href="/api/run" class="run-btn" style="margin-top: 0.75rem;">Run Check Now</a>
    <div class="status" style="margin-top: 1rem;">
      <div class="status-header">
        <div class="status-dot"></div>
        <span class="status-title">System Active</span>
      </div>
      <div class="stats">
        <div class="stat">
          <span class="stat-label">Last Check</span>
          <span class="stat-value">${lastCheck !== "Never" ? formatDatePST(new Date(lastCheck)) : "Never"}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Current Inmates</span>
          <span class="stat-value">${inmateCount}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Changes Detected</span>
          <span class="stat-value">${changeCount}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Page Views</span>
          <span class="stat-value">${viewCount.toLocaleString()}</span>
        </div>
      </div>
    </div>
    <div class="footer">
      <p style="margin-top: 0.5rem;">Monitoring <a href="https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf" target="_blank">Mason County Jail Roster</a></p>
      <a href="/legislative" style="display: inline-block; margin-top: 1rem; padding: 0.5rem 1rem; background: #C1B09A; color: #191D18; border-radius: 6px; text-decoration: none; font-size: 0.75rem;">March 6th 2026: Washington State Legislative Session News Update</a>
    </div>
  </div>
</body>
</html>`;

  res.send(html);
});

// Helper function to extract date from log line
function extractDateFromLine(line) {
  // Extract date from line like "Name | Booked: 01/18/26 01:45:00 | Charges: ..."
  const bookedMatch = line.match(/Booked:\s+(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (bookedMatch) {
    return parseBookingDate(bookedMatch[1]);
  }
  
  // Also check for "Released:" format
  const releasedMatch = line.match(/Released:\s+(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (releasedMatch) {
    return parseBookingDate(releasedMatch[1]);
  }
  
  // If no valid date found, return current date
  return new Date();
}

// Run check
app.get('/api/run', async (req, res) => {
  try {
    ensureStorageDir();

    // Fetch main roster
    const response = await fetch(PDF_URL);
    if (!response.ok) {
      throw new Error("Failed to download PDF: " + response.status);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const pdfPath = path.join(STORAGE_DIR, "current.pdf");
    fs.writeFileSync(pdfPath, buffer);

    const result = await PDFParser(buffer);
    const text = result.text;

    const textPath = path.join(STORAGE_DIR, "current_text.txt");
    fs.writeFileSync(textPath, text);
    
    // Also save a sample block for debugging
    const sampleBlock = text.substring(0, 2000);
    const debugPath = path.join(STORAGE_DIR, "debug_sample.txt");
    fs.writeFileSync(debugPath, sampleBlock);

    // Fetch release stats
    const releaseStats = await fetchReleaseStats();

    const currentHash = crypto.createHash("md5").update(text).digest("hex");
    const timestamp = new Date().toISOString();

    const hashFile = path.join(STORAGE_DIR, "prev_hash.txt");
    const rosterFile = path.join(STORAGE_DIR, "prev_roster.txt");
    const logFile = path.join(STORAGE_DIR, "change_log.txt");
    const pendingReleasesFile = path.join(STORAGE_DIR, "pending_releases.json");

    let previousHash;
    let previousText;
    let hasChanged = false;
    let isFirstRun = false;
    let addedLines = [];
    let removedLines = [];
    
    // Load pending releases
    let pendingReleases = [];
    if (fs.existsSync(pendingReleasesFile)) {
      try {
        pendingReleases = JSON.parse(fs.readFileSync(pendingReleasesFile, "utf-8"));
      } catch (e) {
        pendingReleases = [];
      }
    }

    if (fs.existsSync(hashFile) && fs.existsSync(rosterFile)) {
      previousHash = fs.readFileSync(hashFile, "utf-8").trim();
      previousText = fs.readFileSync(rosterFile, "utf-8");
      hasChanged = currentHash !== previousHash;

      if (hasChanged) {
        const currentBookings = extractBookings(text);
        const previousBookings = extractBookings(previousText);

        for (const [id, booking] of currentBookings) {
          if (!previousBookings.has(id)) {
            addedLines.push(formatBooked(booking));
          }
        }
        
        // Track releases
        const newPendingReleases = [];
        for (const [id, booking] of previousBookings) {
          if (!currentBookings.has(id)) {
            const releaseResult = formatReleased(booking, releaseStats, true);
            removedLines.push(releaseResult.text);
            
            // If release details are pending, track it
            if (releaseResult.hasPendingDetails) {
              newPendingReleases.push({
                name: booking.name,
                bookingData: booking,
                detectedAt: timestamp
              });
            }
          }
        }
        
        // Update pending releases list
        pendingReleases = [...pendingReleases, ...newPendingReleases];
        
        addedLines = addedLines.slice(0, 30);
        removedLines = removedLines.slice(0, 30);
      }
    } else {
      isFirstRun = true;
    }
    
    // Check for updates to pending releases
    let updatedReleases = [];
    let stillPending = [];
    
    for (const pending of pendingReleases) {
      const releaseInfo = releaseStats.get(pending.name);
      if (releaseInfo) {
        // Found updated info!
        updatedReleases.push({
          name: pending.name,
          details: releaseInfo,
          charges: pending.bookingData.charges
        });
      } else {
        // Still waiting for details
        stillPending.push(pending);
      }
    }
    
    // Save updated pending list
    fs.writeFileSync(pendingReleasesFile, JSON.stringify(stillPending, null, 2));

    fs.writeFileSync(hashFile, currentHash);
    fs.writeFileSync(rosterFile, text);

      // Build log entry for roster changes
    let logEntry = "";
    
    if (isFirstRun) {
      // On first run, log all current inmates as booked
      const currentBookings = extractBookings(text);
      const allInmates = Array.from(currentBookings.values()).map(b => formatBooked(b));
      
      // Sort by booking date (newest first)
      allInmates.sort((a, b) => {
        const dateA = extractDateFromLine(a);
        const dateB = extractDateFromLine(b);
        return dateB - dateA; // Newest first
      });
      
      logEntry = allInmates.map(l => "BOOKED | " + l).join("\n") + "\n\n";
      
    } else if (hasChanged) {
      // For changes, add new bookings and releases in chronological order
      const changes = [];
      
      // Add new bookings
      addedLines.forEach(line => {
        changes.push({
          type: "BOOKED",
          line: line,
          date: extractDateFromLine(line)
        });
      });
      
      // Add releases (convert format)
      removedLines.forEach(line => {
        // Convert "Name | Booked: Date | Charges" to "Name | Released: Date | Charges"
        const releaseLine = line.replace("Booked:", "Released:");
        changes.push({
          type: "RELEASED",
          line: releaseLine,
          date: extractDateFromLine(line) || new Date() // Use booking date or current date
        });
      });
      
      // Sort changes by date (newest first)
      changes.sort((a, b) => b.date - a.date);
      
      // Format changes
      logEntry = changes.map(c => `${c.type} | ${c.line}`).join("\n") + "\n\n";
      
    } else {
      logEntry = ""; // No changes, don't add anything
    }

    fs.appendFileSync(logFile, logEntry);
    
    // Add separate entry for updated release details if any
    if (updatedReleases.length > 0) {
      const updateEntry =
        "\n================================================================================\n" +
        "Release details update at: " + timestamp +
        "\n================================================================================\n" +
        "UPDATED RELEASE INFORMATION (" + updatedReleases.length + "):\n" +
        updatedReleases.map(r => {
          const bailAmount = parseFloat(r.details.bail.replace(/[$,]/g, ''));
          const bailText = bailAmount > 0 ? " | Bail Posted: " + r.details.bail : "";
          
          return "  ✓ " + r.name + " | Released: " + r.details.releaseDateTime + 
            " | Time served: " + r.details.timeServed + 
            bailText +
            " (" + r.details.releaseType + ")" +
            " | Charges: " + (r.charges.join(", ") || "None listed");
        }).join("\n") + "\n";
      
      fs.appendFileSync(logFile, updateEntry);
    }

    const message = isFirstRun
      ? "Initial roster captured successfully!"
      : hasChanged
        ? "Changes detected! " + addedLines.length + " new bookings, " + removedLines.length + " releases." +
          (updatedReleases.length > 0 ? " Also updated " + updatedReleases.length + " release details." : "")
        : updatedReleases.length > 0
          ? "Updated release details for " + updatedReleases.length + " inmates."
          : "No changes detected.";

    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/api/history"><style>body{font-family:sans-serif;background:#191D18;color:#C1B09A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.success{color:#8A7A68;font-size:3rem;margin-bottom:1rem;}h1{color:#E5DDD0;margin-bottom:1rem;}p{color:#FFFFFF;}</style></head><body><div class="container"><div class="success">✓</div><h1>Workflow Complete</h1><p>' +
      message +
      "</p><p>Redirecting to Change Log...</p></div></body></html>";

    res.send(html);
  } catch (error) {
    console.error('Error in /api/run:', error);
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#191D18;color:#C1B09A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.error{color:#ef4444;font-size:3rem;margin-bottom:1rem;}h1{color:#ef4444;margin-bottom:1rem;}p{color:#FFFFFF;}a{color:#C1B09A;}</style></head><body><div class="container"><div class="error">✗</div><h1>Error</h1><p>' +
      (error.message || "Unknown error") +
      '</p><p><a href="/api/status">Back to Status</a></p></div></body></html>';
    res.send(html);
  }
});
// Legislative session page
app.get('/legislative', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Washington State Legislative Session News</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 9pt; background: #191D18; color: #C1B09A; min-height: 100vh; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-family: 'Pixel Digivolve', 'Courier New', monospace; font-size: 2rem; margin-bottom: 0.5rem; color: #E5DDD0; letter-spacing: -1px; }
    .subtitle { color: #72807A; margin-bottom: 2rem; }
    .back-link { display: inline-block; margin-bottom: 1.5rem; color: #8A7A68; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .content { background: #2A3828; border-radius: 12px; padding: 2rem; margin-bottom: 1rem; line-height: 1.6; }
    .content h2 { color: #8A7A68; margin-top: 1.5rem; margin-bottom: 0.75rem; font-size: 1.2rem; }
    .content h2:first-child { margin-top: 0; }
    .content h3 { color: #C1B09A; margin-top: 1rem; margin-bottom: 0.5rem; font-size: 1rem; }
    .content p { margin-bottom: 0.75rem; color: #FFFFFF; }
    .content ul { margin-left: 1.5rem; margin-bottom: 1rem; }
    .content li { margin-bottom: 0.5rem; color: #FFFFFF; }
    .update-date { color: #72807A; font-weight: bold; margin-bottom: 1rem; }
    .content strong { color: #C1B09A; }
    a { color: #8A7A68; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/status" class="back-link">← Back to Jail Roster Monitor</a>
    <h1>Washington State Legislative Session</h1>
    <p class="subtitle">2026 Session — Final Week Update</p>

    <div class="content">
      <p class="update-date">Updated: 3/6/2026</p>

      <h2>Washington state legislature 2026 — final week, where things stand</h2>

      <h3>SESSION STATUS:</h3>
      <p>Day 54 of 60. Session ends March 12, 2026. Final floor votes happening this week — anything that hasn't crossed chambers is almost certainly dead. Budget bills and anything tagged "necessary to implement the budget" (NTIB) are exempt from cutoffs and can move until the last day. Governor has until April 4 to sign or veto bills that land on his desk.</p>

      <h3>POLICE &amp; PUBLIC SAFETY:</h3>
      <p><strong>BAN ON POLICE FACE COVERINGS (SB 5855) PASSED BOTH CHAMBERS</strong> — Both chambers passed this in the final days of session. House passed 56-37 along party lines. Senate passed 30-18. Applies to state, local, and federal officers — though whether federal agents will comply is an open question. Ferguson has promised to sign it; takes effect immediately upon signature due to emergency clause.</p>
      <p><strong>BAN ON FAKE BADGES / FALSE LAW ENFORCEMENT IMPERSONATION (SB 5876) PASSED BOTH CHAMBERS</strong> — Companion bill to the mask ban, also a Ferguson priority. Prohibits anyone who isn't a cop from making, possessing, or providing law enforcement insignia in a way that would make a reasonable person think they're an officer. Direct response to ICE activity. Ferguson vowed to sign it.</p>
      <p><strong>$100 MILLION POLICE HIRING GRANTS (SB 5060) ADVANCING</strong> — Ferguson's priority. Covers 75% of new officer salaries for 36 months. Cities must implement a 0.1% sales tax or already have a similar tax to qualify.</p>
      <p><strong>SHERIFF/POLICE CHIEF REQUIREMENTS (HB 1399/SB 5974) ADVANCING</strong> — Minimum age 25, background checks, must maintain peace officer certification. Sheriffs union is still pissed, calling it unconstitutional.</p>
      <p><strong>PUBLIC DEFENSE CRISIS (SB 5404) ADVANCING</strong> — Making the state actually fund public defenders. WA is one of only 2 states that doesn't fully fund them, leading to overworked defenders and constitutional violations.</p>
      <p><strong>FLOCK LICENSE PLATE CAMERA REGULATION (SB 5550 / ESSB 6002) ADVANCING</strong> — Passed the Senate. Scheduled for executive session in House Civil Rights &amp; Judiciary. Regulates automated license plate readers.</p>
      <p><strong>NO SECRET POLICE ACT EFFECTIVELY ACCOMPLISHED</strong> — Covered by the mask ban above. Requiring law enforcement to be identifiable during arrests.</p>
      <p><strong>BODY CAMERAS FOR ICE ENCOUNTERS (HB 2648) ADVANCING</strong> — Passed House Community Safety Committee. Requires local police to activate body cams when encountering federal agents doing immigration enforcement and report encounters to their agency.</p>
      <p><strong>ICE HIRING BAN (HB 2641) DEAD</strong> — Died in committee Feb 5. Would've prohibited hiring former federal immigration agents hired under Trump after Jan 20, 2025.</p>

      <h3>GUN CONTROL:</h3>
      <p><strong>PERMIT TO PURCHASE (HB 1163)</strong> — Requiring a state permit before buying firearms, like a dozen other states.</p>
      <p><strong>GUN-FREE ZONE EXPANSION + BULK PURCHASE LIMITS, GUN STORAGE REQUIREMENTS, GUN DEALER REGULATIONS</strong> — Still in play heading into the final stretch.</p>

      <h3>SOCIAL MEDIA &amp; CHILDREN:</h3>
      <p><strong>ADDICTIVE FEEDS BAN (HB 1834/SB 5708) ADVANCING</strong> — AG Nick Brown's priority. Bans algorithmic addictive feeds for minors and blocks push notifications during overnight hours and school hours. Modeled on California law. Had renewed momentum after stalling in 2025. Still moving as of final week.</p>
      <p><strong>PARENTAL CONSENT FOR SOCIAL MEDIA (SB 6111) DEAD</strong> — Died at first cutoff. Would've required parental consent for minors under 17 to create accounts.</p>
      <p><strong>CHILD INFLUENCER PROTECTIONS (HB 2400) DEAD</strong> — Died at first cutoff. Would've protected kids in monetized family content and let young adults request deletion of childhood videos.</p>
      <p><strong>PORNOGRAPHY ACCESS RESTRICTIONS DEAD</strong> — Bipartisan bill died at first cutoff.</p>

      <h3>EDUCATION:</h3>
      <p><strong>PARENTAL RIGHTS INITIATIVES</strong> — Two controversial initiatives still in play. Would give parents access to all school curriculum and allow them to see school mental health counseling records. Controversial rewrite of last year's HB 1296.</p>
      <p><strong>HOMESCHOOL AGE REQUIREMENT (SB 6261) DEAD</strong> — Died. Would've lowered homeschool attestation requirement from age 8 to age 6. WA is the only state that waits until age 8.</p>

      <h3>CANNABIS:</h3>
      <p><strong>HOME GROW LEGISLATION (SB 6204 / HB 2614) UNCERTAIN — FINAL WEEK</strong> — Senate Labor &amp; Commerce passed it. Allows adults 21+ to grow up to 6 plants per person, max 15 per household. Includes the Schoesler amendment letting local jurisdictions ban home grow in residential zones. Still alive as of the final week but hasn't crossed chambers yet. This is the 11th year in a row this has been attempted. WA is one of only 3 states to have legalized both medical and recreational cannabis while still criminalizing home grow — and the only one where it's a felony.</p>
      <p><strong>LOCAL CANNABIS TAX (SB 6328)</strong> — Would allow counties or cities (not both) to impose up to 2% additional excise tax on retail cannabis sales for up to 7 years. Still alive in Ways &amp; Means.</p>
      <p><strong>CANNABIS HOSPITALITY EVENTS ADVANCING</strong> — Referred to House Appropriations. Tagged as potentially NTIB (revenue-generating), which gives it cover to move until the end of session.</p>
      <p><strong>CANNABIS TAX OVERHAUL (HB 2433)</strong> — Would replace WA's 37% excise tax (highest in the nation) with weight and THC potency-based rates. Industry groups vocally opposed, arguing it would actually raise taxes significantly on lower-cost products. Public hearing pulled from Senate Ways &amp; Means calendar in early Feb with no reschedule — likely dead or severely stalled.</p>
      <p><strong>HIGH-THC CANNABIS TAX INCREASE (HB 2075)</strong> — Would increase excise tax specifically on high-THC products. Status unclear.</p>

      <h3>TAXES &amp; BUDGET:</h3>
      <p><strong>MILLIONAIRE INCOME TAX (SB 6346) TOUCH AND GO</strong> — 9.9% tax on income over $1 million. Would raise an estimated $3.7 billion annually starting in 2029. Passed the Senate 27-22 on Feb 16. Moving through the House with significant friction — a committee stripped a key corporate tax break, then tech leaders sent a letter urging Ferguson to pump the brakes. As of March 4, it still hadn't hit the House floor with just days left. Ferguson has said publicly he'll support it but only if revenue is earmarked for working-family tax relief, not the general fund. Republicans are already threatening lawsuits over the state constitution's income tax prohibition. Even optimists acknowledge this might spill into the 2027 long session.</p>
      <p><strong>PAYROLL TAX ON HIGH EARNERS (HB 2100)</strong> — 5% tax on employers for employees making over $125k/year to fund the "Well Washington Fund" for healthcare, education, and human services.</p>
      <p><strong>HIGHER EDUCATION FUNDING RESET</strong> — 10% tuition cuts for 3 years starting fall 2027, expanding Washington College Grant eligibility.</p>
      <p><strong>PAID PROTESTER TAX</strong> — Would tax temporary staffing agencies that provide "paid protesters."</p>
      <p><strong>BULLION TAX REPEAL (HB 2093)</strong> — Republicans trying to eliminate the sales tax on gold and silver, arguing it's driving coin shops out of business.</p>
      <p><strong>REVERSING 2025 TAX INCREASES (HB 2101)</strong> — Rolling back recent tax hikes to keep investment local.</p>

      <h3>ARTIFICIAL INTELLIGENCE:</h3>
      <p><strong>AI COMPANION CHATBOTS (SB 5984 / HB 2225) ADVANCING — LIKELY TO PASS</strong> — Ferguson's priority. HB 2225 passed the House 69-28 on Feb 17. SB 5984 passed the Senate earlier and was in House committee executive session by Feb 24. Both advancing and likely to make it. Prohibits romantic AI relationships with minors, requires hourly notifications that it's not human, includes suicide prevention protocols and a private right of action. Tech industry pushing back hard.</p>
      <p><strong>AI IN SCHOOLS (HB 2481/SB 5956) ADVANCING</strong> — SB 5956 was in House Education executive session. Requires human oversight of AI systems in schools, addressing surveillance, risk scoring, and automated discipline. Yes, there is actually AI flagging chips bags as weapons in school hallways.</p>
      <p><strong>AI DEEPFAKES / DIGITAL LIKENESS BILL ADVANCING</strong> — Requiring developers to make tools available so people can tell when something is AI-generated. Also includes protections for people's AI-generated digital likeness. Crossed chambers.</p>
      <p><strong>AI USE IN THERAPY / MENTAL HEALTH TREATMENT</strong> — Regulations for AI in mental health contexts still in play.</p>
      <p><strong>HEALTH INSURANCE AI AUTHORIZATION</strong> — Regulating AI insurance authorization decisions for medical procedures.</p>
      <p><strong>TRAINING DATA TRANSPARENCY</strong> — Requiring disclosure of what data is used to train AI models.</p>
      <p><strong>COLLECTIVE BARGAINING AROUND AI</strong> — Allowing unions to negotiate how AI is used in workplaces.</p>
      <p><strong>GROCERY STORE AI SURVEILLANCE</strong> — Regulating facial recognition and AI-based surge pricing.</p>

      <h3>WILDFIRE &amp; ENVIRONMENT:</h3>
      <p><strong>WILDFIRE PREVENTION FUNDING</strong> — Fighting a $60 million cut to wildfire resilience budget. $125 million per biennium for forest health.</p>
      <p><strong>CLEAN ENERGY GRID EXPANSION</strong> — Still in play, along with a semi truck emissions climate push.</p>

      <h3>HOUSING &amp; DEVELOPMENT:</h3>
      <p><strong>COMMERCIAL TO RESIDENTIAL CONVERSION (SB 6026) ADVANCING</strong> — Governor's priority. Requires local governments to allow mixed-use and residential in commercially zoned areas without rezoning. Abandoned strip malls and big-box stores could become housing.</p>
      <p><strong>SHORT-TERM RENTAL TAX (SB 5576)</strong> — Up to 4% excise tax on Airbnbs to fund affordable housing. Was statewide, amended to let local governments decide. Airbnb pumped $4 million into a PAC to kill it — they spent one-fifth of what the tax would generate just to stop local governments from having the option.</p>
      <p><strong>SINGLE-FAMILY ZONING REFORM</strong> — Already passed in 2025, continuing to implement rules reducing parking requirements near transit that drive up housing costs.</p>
      <p><strong>LIMITING BULK HOME BUYING (E2SSB 5496) ADVANCING</strong> — Would preserve homeownership options by limiting excessive home buying by certain entities (hedge funds and institutional buyers).</p>

      <h3>IMMIGRATION &amp; LABOR:</h3>
      <p><strong>IMMIGRANT WORKER PROTECTIONS (HB 2105/SB 5852) ADVANCING</strong> — Passed the Senate. Requires employers to give workers notice if ICE does an I-9 audit. Also prohibits school district and early learning employees from collecting data on students' or families' immigration status.</p>
      <p><strong>FARMWORKER COLLECTIVE BARGAINING (SB 6045/HB 2409)</strong> — Would bring farmworkers under Public Employment Relations Commission jurisdiction. Farmworkers have been excluded from National Labor Relations Act protections since 1935.</p>
      <p><strong>MINIMUM WAGE $17.13/HOUR ALREADY IN EFFECT</strong> — Took effect Jan 1, 2026. Highest in the nation. Some cities are higher: Seattle $21.63, SeaTac $20.74.</p>
      <p><strong>32-HOUR WORKWEEK (HB 2611) DEAD</strong> — Would've required overtime after 32 hours per week. Food, hospitality, and farm industries opposed. San Juan County implemented a 32-hour week for county employees in 2023: 18% decrease in sick calls, 216% increase in job applications, $2 million saved.</p>
      <p><strong>STRIKING WORKERS GET UNEMPLOYMENT ALREADY IN EFFECT</strong> — Strikers can collect up to 6 weeks of unemployment benefits after a strike starts.</p>
      <p><strong>PAID FAMILY LEAVE EXPANSION</strong> — Job protection kicks in after only 180 days (down from 12 months). Minimum leave reduced to 4 hours (from 8 hours).</p>
      <p><strong>WORKPLACE VIOLENCE PREVENTION</strong> — Healthcare facilities must investigate violence incidents promptly and update prevention plans annually.</p>
      <p><strong>ISOLATED WORKER PROTECTIONS</strong> — Panic buttons and safety measures for janitors, housekeepers, and security guards who work alone.</p>

      <h3>HEALTHCARE &amp; VACCINES:</h3>
      <p><strong>STATE VACCINE AUTHORITY (SB 5967/HB 2242) ADVANCING</strong> — Ferguson's priority. Allows WA Dept of Health to make vaccine recommendations independent of the CDC. Direct response to Trump politicizing the CDC. Does NOT create new mandates.</p>

      <h3>ALREADY IN EFFECT:</h3>
      <p><strong>MEDICAL DEBT CREDIT REPORTING BAN IN EFFECT</strong> — Medical debt can no longer be reported to credit agencies.</p>
      <p><strong>BLOOD TYPE ON DRIVER'S LICENSE (SB 5689) IN EFFECT</strong> — Voluntary blood type info on state IDs. WA is among the first states to offer this.</p>
      <p><strong>NICOTINE/VAPE TAX IN EFFECT</strong> — 95% excise tax on all nicotine products including synthetic nicotine, vapes, and pouches. A $7 product now costs $15.06 after taxes.</p>
      <p><strong>PLASTIC BAG FEE INCREASE IN EFFECT</strong> — Minimum charge raised from 8 cents to 12 cents per bag.</p>
      <p><strong>CHILD SUPPORT REFORM IN EFFECT</strong> — Updated economic tables now cover incomes up to $50,000 combined per month, up from the old $12,000 cap.</p>

      <h3>TRANSPORTATION &amp; ROADS:</h3>
      <p><strong>RECKLESS DRIVING REDEFINED (SB 5890)</strong> — 30+ mph over the speed limit = reckless driving charge.</p>
      <p><strong>RECKLESS INTERFERENCE WITH EMERGENCY OPERATIONS (HB 2203) DEAD</strong> — New driving offense for blocking emergency vehicles passed the House but didn't make it through a Senate policy committee.</p>

      <h3>CRIMINAL JUSTICE:</h3>
      <p><strong>POLITICAL AFFILIATION HATE CRIME (SB 5830)</strong> — Makes it a Class C felony to assault someone based on their political beliefs.</p>
      <p><strong>JUVENILE DETENTION OVERCROWDING</strong> — Allowing youth transfers to state prisons and community facilities in certain cases.</p>
      <p><strong>EARLY RELEASE FOR YOUTH OFFENDERS</strong> — Allowing people convicted before age 18 to petition for early release at age 24.</p>
      <p><strong>DUI LAB EXPANSION</strong> — Allowing more labs to perform toxicology tests to speed up DUI cases.</p>
      <p><strong>LOWER BAC THRESHOLD</strong> — Lowering the drunk driving legal limit is in the mix this session.</p>

      <h3>RANDOMS:</h3>
      <p><strong>DIAPER CHANGING STATIONS IN EFFECT</strong> — Mandatory in all new or remodeled public buildings costing $15k+.</p>
      <p><strong>GRAY WOLF RECLASSIFICATION</strong> — Downgrading from "endangered" to "sensitive" status.</p>
      <p><strong>DISCOVER PASS PRICE HIKE</strong> — Increasing from $30 to $45 for state parks access; would be the first increase in 14 years.</p>
      <p><strong>POSTHUMOUS CANDIDATE BALLOT REMOVAL DEAD</strong> — Would have allowed removal of deceased candidates from ballots after the filing deadline. Passed the House, didn't make it out of a Senate policy committee. Prompted by Tom Crowson, who died close enough to the primary that he nearly won posthumously.</p>

      <p style="margin-top: 2rem; color: #72807A; font-style: italic;">For more information, visit <a href="https://leg.wa.gov" target="_blank">leg.wa.gov</a>. Session ends March 12, 2026.</p>
    </div>
  </div>
</body>
</html>`;
  
  res.send(html);
});

// History page - UPDATED for new log format
app.get('/api/history', (req, res) => {
  const dataDir = STORAGE_DIR;
  let changeLog = "";
  let entries = [];

  try {
    const logFile = path.join(dataDir, "change_log.txt");
    if (fs.existsSync(logFile)) {
      changeLog = fs.readFileSync(logFile, "utf-8");
      
      // Parse new format: just lines with BOOKED | or RELEASED |
      const lines = changeLog.split('\n').filter(l => l.trim());
      
      // Group by date
      const entriesByDate = {};
      
      for (const line of lines) {
        if (line.startsWith('BOOKED |') || line.startsWith('RELEASED |')) {
          // Extract date from line
          const dateMatch = line.match(/(?:Booked|Released):\s+(\d{2}\/\d{2}\/\d{2})/);
          if (dateMatch) {
            const dateKey = dateMatch[1]; // Use date as key
            
            if (!entriesByDate[dateKey]) {
              entriesByDate[dateKey] = { date: dateKey, booked: [], released: [] };
            }
            
            if (line.startsWith('BOOKED |')) {
              entriesByDate[dateKey].booked.push(line.replace('BOOKED | ', ''));
            } else {
              entriesByDate[dateKey].released.push(line.replace('RELEASED | ', ''));
            }
          }
        }
      }
      
      // Convert to array and sort by date (newest first)
      entries = Object.values(entriesByDate).sort((a, b) => {
        const [aMonth, aDay, aYear] = a.date.split('/').map(Number);
        const [bMonth, bDay, bYear] = b.date.split('/').map(Number);
        const aDate = new Date(2000 + aYear, aMonth - 1, aDay);
        const bDate = new Date(2000 + bYear, bMonth - 1, bDay);
        return bDate - aDate;
      });
    }
  } catch (e) {
    console.error('History parse error:', e);
  }

  const entriesHtml = entries.length > 0 ? entries.map(entry => {
    const [month, day, year] = entry.date.split('/');
    const displayDate = `${month}/${day}/20${year}`;
    
    const bookedHtml = entry.booked.length > 0 ? 
      '<div class="changes booked"><h4>BOOKED (' + entry.booked.length + ')</h4><ul>' +
      entry.booked.map(b => '<li>' + b + '</li>').join('') +
      '</ul></div>' : '';
      
    const releasedHtml = entry.released.length > 0 ?
      '<div class="changes released"><h4>RELEASED (' + entry.released.length + ')</h4><ul>' +
      entry.released.map(r => '<li>' + r + '</li>').join('') +
      '</ul></div>' : '';

    const changesGrid = (bookedHtml && releasedHtml)
      ? '<div class="changes-grid">' + bookedHtml + releasedHtml + '</div>'
      : bookedHtml + releasedHtml;
    return '<div class="entry"><div class="entry-header">' + displayDate + '</div>' +
           changesGrid + '</div>';
  }).join('') : 
  '<p class="no-data">No changes recorded yet. Run the workflow to start monitoring.</p>';

  const html = `<!DOCTYPE html>
<html>
<head>

<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-380L7KND2L"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-380L7KND2L');
</script>

  <title>Booked and Released Log - Mason County Jail Roster Monitor</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
  <style>
    @font-face { font-family: 'Fake Receipt'; src: url('/fonts/FakeReceipt.otf') format('opentype'); font-weight: normal; font-style: normal; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { overflow-x: hidden; width: 100%; }
    body { font-family: Arial, sans-serif; font-size: 8pt; background: #191D18; color: #C1B09A; min-height: 100vh; padding: 2rem; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { font-family: 'Fake Receipt', 'Courier New', monospace; font-size: 2.5rem; margin-bottom: 0.5rem; color: #E5DDD0; letter-spacing: 1px; word-break: break-word; }
    .subtitle { color: #72807A; margin-bottom: 1.5rem; }
    .nav-buttons { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; }
    .nav-btn { flex: 1; padding: 0.65rem 1rem; background: #2A3828; color: #E5DDD0; text-align: center; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 9pt; transition: background 0.15s; }
    .nav-btn:hover { background: #3A4E38; color: #E5DDD0; }
    .entry { background: #222C22; border-radius: 12px; padding: 1rem; margin-bottom: 1rem; }
    .entry.no-change-entry { background: #0E1410; padding: 0.75rem; border-left: 3px solid #283C2A; }
    .entry-header { font-family: 'Fake Receipt', 'Courier New', monospace; font-weight: 600; font-size: 11pt; margin-bottom: 0.75rem; color: #C1B09A; border-bottom: 1px solid #283C2A; padding-bottom: 0.5rem; }
    .changes-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.75rem; }
    .changes { }
    .changes h4 { font-family: 'Fake Receipt', 'Courier New', monospace; font-size: 10pt; margin-bottom: 0.4rem; font-weight: bold; letter-spacing: 0.5px; }
    .changes.booked { border-left: 3px solid #C8B88A; padding-left: 0.6rem; }
    .changes.booked h4 { color: #C8B88A; }
    .changes.released { border-left: 3px solid #8A7A68; padding-left: 0.6rem; }
    .changes.released h4 { color: #8A7A68; }
    .changes.updated { border-left: 3px solid #C8B88A; padding-left: 0.6rem; }
    .changes.updated h4 { color: #C8B88A; }
    .changes ul { list-style: none; font-size: 8pt; color: #B8AFA0; }
    .changes ul li { padding: 0.2rem 0; border-bottom: 1px solid #283C2A; }
    .changes ul li:last-child { border-bottom: none; }
    .no-changes { color: #72807A; font-style: italic; }
    .no-data { color: #72807A; text-align: center; padding: 3rem; }
    a { color: #8A7A68; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Booked and Released Log</h1>
    <p class="subtitle">Record of all Bookings and Releases, with newest first</p>
    <div class="nav-buttons">
      <a href="/api/status" class="nav-btn">← Main Page</a>
      <a href="/api/stats" class="nav-btn">Statistics Dashboard →</a>
    </div>
    ${entriesHtml}
  </div>
</body>
</html>`;

  res.send(html);
});

app.get('/api/admin/deduplicate', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    const content = fs.readFileSync(logFile, 'utf-8');
    
    const lines = content.split('\n');
    const uniqueLines = [...new Set(lines)]; // Remove duplicates
    
    const deduped = uniqueLines.join('\n');
    
    // Backup original
    fs.writeFileSync(logFile + '.backup', content);
    
    // Write deduplicated version
    fs.writeFileSync(logFile, deduped);
    
    res.json({
      success: true,
      originalLines: lines.length,
      uniqueLines: uniqueLines.length,
      removed: lines.length - uniqueLines.length
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Stats Dashboard - UPDATED for new format
app.get('/api/stats', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');

     // THIS SECTION is going to add info about how l ong stats have been documented,. 
    // Get data collection start date from first entry in log
    let dataCollectionStart = null;
    let daysOfData = 0;
    
    if (fs.existsSync(logFile)) {
      const logContent = fs.readFileSync(logFile, 'utf-8');
      const lines = logContent.split('\n');
      
      // Find first dated entry
      for (const line of lines) {
        const dateMatch = line.match(/(?:Booked|Released):\s+(\d{2}\/\d{2}\/\d{2})/);
        if (dateMatch) {
          const [month, day, year] = dateMatch[1].split('/');
          const fullYear = 2000 + parseInt(year);
          const firstDate = new Date(fullYear, parseInt(month) - 1, parseInt(day));
          dataCollectionStart = firstDate;
          
          // Calculate days since then
          const now = new Date();
          daysOfData = Math.floor((now - firstDate) / (1000 * 60 * 60 * 24));
          break;
        }
      }
    }
    // ↑↑↑ END OF NEW SECTION

    if (!fs.existsSync(logFile)) {
      return res.send(getStatsHTML({
        totalBookings: 0,
        totalReleases: 0,
        currentPopulation: 0,
        avgPopulation: 0,
        commonCharges: [],
        bookingsByDay: {},
        avgStayDays: 0,
        releaseTypes: {},
        timeSeriesData: [],
        totalBailThisMonth: 0,
        avgBailByCharge: [],
        avgTimeServedMins: 0,
        minTimeServedMins: 0,
        maxTimeServedMins: 0,
        longestInmate: null,
        daysOfData: 0,
        dataCollectionStart: null,
      }));
    }

    const logContent = fs.readFileSync(logFile, 'utf-8');
    
    // Parse the log file for NEW format
    let totalBookings = 0;
    let totalReleases = 0;
    let allCharges = [];
    let releaseTypes = {};
    let bookingDates = [];
    let releaseDates = [];
    let stayDurations = [];
    let popEvents = []; // {ts: Date, delta: 1|-1} for avg population

    const lines = logContent.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Check for BOOKED entries in NEW format: "BOOKED | NAME | Booked: DATE | Charges: ..."
      if (trimmedLine.startsWith('BOOKED |')) {
        totalBookings++;
        
        // Extract date
        const dateMatch = trimmedLine.match(/Booked:\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        if (dateMatch) {
          const dateStr = dateMatch[1]; // "01/18/26"
          const timeStr = dateMatch[2];
          const [month, day, year] = dateStr.split('/');
          const [hour, min, sec] = timeStr.split(':');
          const fullYear = 2000 + parseInt(year);
          const date = new Date(fullYear, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min), parseInt(sec));
          bookingDates.push(date);
          popEvents.push({ ts: date, delta: 1 });
        }
        
        // Extract charges
        const chargesMatch = trimmedLine.match(/Charges:\s+(.+)/);
        if (chargesMatch) {
          const charges = chargesMatch[1].trim();
          if (charges && charges !== 'None listed') {
            const chargeList = charges.split(',').map(c => c.trim());
            allCharges.push(...chargeList);
          }
        }
      }
      
      // Check for RELEASED entries in NEW format: "RELEASED | NAME | Released: DATE | Charges: ..."
      else if (trimmedLine.startsWith('RELEASED |')) {
        totalReleases++;
        
        // Extract release type
        if (trimmedLine.includes('Not Released')) {
          releaseTypes['Not Released'] = (releaseTypes['Not Released'] || 0) + 1;
        } else if (trimmedLine.includes('Released:')) {
          releaseTypes['Released'] = (releaseTypes['Released'] || 0) + 1;
        }
        
        // Extract release date
        const dateMatch = trimmedLine.match(/Released:\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        if (dateMatch) {
          const dateStr = dateMatch[1]; // "01/18/26"
          const timeStr = dateMatch[2];
          const [month, day, year] = dateStr.split('/');
          const [hour, min, sec] = timeStr.split(':');
          const fullYear = 2000 + parseInt(year);
          const date = new Date(fullYear, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min), parseInt(sec));
          releaseDates.push(date);
          popEvents.push({ ts: date, delta: -1 });
        }
        
        // Extract charges from releases too
        const chargesMatch = trimmedLine.match(/Charges:\s+(.+)/);
        if (chargesMatch) {
          const charges = chargesMatch[1].trim();
          if (charges && charges !== 'None listed' && charges !== 'Not Released') {
            const chargeList = charges.split(',').map(c => c.trim());
            allCharges.push(...chargeList);
          }
        }
      }
      
      // OLD format fallback (if you still have some old entries)
      else if (trimmedLine.startsWith('+ ')) {
        totalBookings++;
        // Handle old "+ NAME | Booked: ..." format if needed
      }
      else if (trimmedLine.startsWith('- ')) {
        totalReleases++;
        // Handle old "- NAME | Released: ..." format if needed
      }
    }
    
    // Calculate charge frequencies
    const chargeCounts = {};
    allCharges.forEach(charge => {
      const cleanCharge = charge.trim().replace(/^[\d.]+/, '').trim();
      if (cleanCharge) {
        chargeCounts[cleanCharge] = (chargeCounts[cleanCharge] || 0) + 1;
      }
    });
    
    const commonCharges = Object.entries(chargeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([charge, count]) => ({ charge, count }));
    
    // Calculate bookings by day of week
    const bookingsByDay = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
    bookingDates.forEach(date => {
      if (date && !isNaN(date.getTime())) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const day = dayNames[date.getDay()];
        bookingsByDay[day] = (bookingsByDay[day] || 0) + 1;
      }
    });
    
    // Calculate average stay duration by matching names
const bookingsByName = new Map();
const releasesByName = new Map();

// Parse bookings
for (const line of lines) {
  if (line.startsWith('BOOKED |')) {
    const nameMatch = line.match(/BOOKED \| ([^|]+) \|/);
    const dateMatch = line.match(/Booked:\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    
    if (nameMatch && dateMatch) {
      const name = nameMatch[1].trim();
      const [dateStr, timeStr] = [dateMatch[1], dateMatch[2]];
      const [month, day, year] = dateStr.split('/');
      const [hours, minutes, seconds] = timeStr.split(':');
      const fullYear = 2000 + parseInt(year);
      const bookDate = new Date(fullYear, parseInt(month) - 1, parseInt(day), 
                                parseInt(hours), parseInt(minutes), parseInt(seconds));
      
      if (!bookingsByName.has(name)) {
        bookingsByName.set(name, []);
      }
      bookingsByName.get(name).push(bookDate);
    }
  }
  
  else if (line.startsWith('RELEASED |')) {
    const nameMatch = line.match(/RELEASED \| ([^|]+) \|/);
    const dateMatch = line.match(/Released:\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    
    if (nameMatch && dateMatch) {
      const name = nameMatch[1].trim();
      const [dateStr, timeStr] = [dateMatch[1], dateMatch[2]];
      const [month, day, year] = dateStr.split('/');
      const [hours, minutes, seconds] = timeStr.split(':');
      const fullYear = 2000 + parseInt(year);
      const releaseDate = new Date(fullYear, parseInt(month) - 1, parseInt(day), 
                                   parseInt(hours), parseInt(minutes), parseInt(seconds));
      
      if (!releasesByName.has(name)) {
        releasesByName.set(name, []);
      }
      releasesByName.get(name).push(releaseDate);
    }
  }
}

// Calculate stays
let totalStayHours = 0;
let stayCount = 0;

for (const [name, bookDates] of bookingsByName.entries()) {
  const relDates = releasesByName.get(name);
  if (relDates) {
    // Match most recent booking to most recent release
    const lastBook = bookDates[bookDates.length - 1];
    const lastRelease = relDates[relDates.length - 1];

    if (lastRelease > lastBook) {
      const stayMs = lastRelease - lastBook;
      const stayHours = stayMs / (1000 * 60 * 60);

      if (stayHours > 0 && stayHours < 8760) { // Between 0 and 365 days
        totalStayHours += stayHours;
        stayCount++;
      }
    }
  }
}

const avgStayDays = stayCount > 0 ? Math.round((totalStayHours / stayCount) / 24) : 0;

    // --- NEW STATS FROM RELEASE HISTORY ---

    // Build name->charges map from BOOKED lines
    const nameToCharges = new Map();
    for (const line of lines) {
      if (line.startsWith('BOOKED |')) {
        const nm = line.match(/BOOKED \| ([^|]+) \|/);
        const ch = line.match(/Charges:\s+(.+)/);
        if (nm && ch) {
          const charges = ch[1].split(',').map(c => c.trim()).filter(c => c && c !== 'None listed');
          nameToCharges.set(nm[1].trim(), charges);
        }
      }
    }

    // Parse RELEASED lines for release types and bail
    const releaseTypeCounts = {};
    const bailByCharge = {};
    let totalBailThisMonth = 0;
    const nowStats = new Date();

    for (const line of lines) {
      if (line.startsWith('RELEASED |')) {
        // Extract release type code from "(RBB)" pattern
        const typeMatch = line.match(/\(([A-Z]{2,5})\)\s*\|/);
        if (typeMatch) {
          const type = typeMatch[1];
          releaseTypeCounts[type] = (releaseTypeCounts[type] || 0) + 1;
        }

        // Extract bail amount
        const bailMatch = line.match(/Bail Posted:\s*\$([\d,]+\.\d{2})/);
        if (bailMatch) {
          const bail = parseFloat(bailMatch[1].replace(/,/g, ''));
          if (bail > 0) {
            // Check if this month
            const dateMatch = line.match(/Released:\s+(\d{2}\/\d{2}\/\d{2})/);
            if (dateMatch) {
              const [rm, rd, ry] = dateMatch[1].split('/');
              const releaseYear = 2000 + parseInt(ry);
              const releaseMonth = parseInt(rm) - 1;
              if (releaseYear === nowStats.getFullYear() && releaseMonth === nowStats.getMonth()) {
                totalBailThisMonth += bail;
              }
            }
            // Correlate bail with charges
            const nm = line.match(/RELEASED \| ([^|]+) \|/);
            if (nm) {
              const charges = nameToCharges.get(nm[1].trim()) || [];
              charges.forEach(charge => {
                if (!bailByCharge[charge]) bailByCharge[charge] = { total: 0, count: 0 };
                bailByCharge[charge].total += bail;
                bailByCharge[charge].count++;
              });
            }
          }
        }
      }
    }

    // Average bail by charge type (top 5)
    const avgBailByCharge = Object.entries(bailByCharge)
      .map(([charge, data]) => ({ charge, avgBail: Math.round(data.total / data.count), count: data.count }))
      .sort((a, b) => b.avgBail - a.avgBail)
      .slice(0, 5);

    // Precise time served and release types from history file
    let historyTimeMinutes = [];
    let finalReleaseTypes = releaseTypeCounts;
    if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
      try {
        const history = JSON.parse(fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8'));
        const historyTypeCounts = {};
        for (const entry of history) {
          const tsMatch = (entry.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
          if (tsMatch) {
            const mins = parseInt(tsMatch[1]) * 1440 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
            if (mins > 0 && mins < 525600) historyTimeMinutes.push(mins);
          }
          if (entry.releaseType) {
            historyTypeCounts[entry.releaseType] = (historyTypeCounts[entry.releaseType] || 0) + 1;
          }
        }
        if (Object.keys(historyTypeCounts).length > 0) finalReleaseTypes = historyTypeCounts;
      } catch (e) { /* ignore */ }
    }

    // Time served stats (precise, from PDF data)
    let avgTimeServedMins = 0, minTimeServedMins = 0, maxTimeServedMins = 0;
    if (historyTimeMinutes.length > 0) {
      avgTimeServedMins = Math.round(historyTimeMinutes.reduce((a, b) => a + b, 0) / historyTimeMinutes.length);
      minTimeServedMins = Math.min(...historyTimeMinutes);
      maxTimeServedMins = Math.max(...historyTimeMinutes);
    }

    // Longest current inmate (from roster)
    let longestInmate = null;
    let longestDays = 0;

    // Get current population from roster file
    let currentPopulation = 0;
    const rosterFile = path.join(STORAGE_DIR, 'prev_roster.txt');
    if (fs.existsSync(rosterFile)) {
      const content = fs.readFileSync(rosterFile, 'utf-8');
      const bookingMatches = content.match(/Booking #:/g);
      currentPopulation = bookingMatches ? bookingMatches.length : 0;

      // Also find longest-serving current inmate
      const currentBookings = extractBookings(content);
      for (const [, booking] of currentBookings.entries()) {
        if (booking.bookDate && booking.bookDate !== 'Unknown') {
          const parts = booking.bookDate.split(' ');
          if (parts.length === 2) {
            const [datePart, timePart] = parts;
            const [bm, bd, by] = datePart.split('/');
            const [bh, bmin, bs] = timePart.split(':');
            const byr = by.length === 2 ? 2000 + parseInt(by) : parseInt(by);
            const bookDate = new Date(byr, parseInt(bm)-1, parseInt(bd), parseInt(bh), parseInt(bmin), parseInt(bs));
            const daysIn = (nowStats - bookDate) / (1000 * 60 * 60 * 24);
            if (daysIn > longestDays) {
              longestDays = daysIn;
              longestInmate = { name: booking.name, days: Math.floor(daysIn), bookDate: booking.bookDate };
            }
          }
        }
      }
    }
    
    // Average daily population from event timeline
    let avgPopulation = 0;
    if (popEvents.length > 0) {
      popEvents.sort((a, b) => a.ts - b.ts);
      // Estimate starting population: current minus net change logged
      const netChange = totalBookings - totalReleases;
      let pop = Math.max(0, currentPopulation - netChange);
      const dailyPops = {};
      for (const ev of popEvents) {
        pop = Math.max(0, pop + ev.delta);
        dailyPops[ev.ts.toDateString()] = pop;
      }
      const pops = Object.values(dailyPops);
      if (pops.length > 0) {
        avgPopulation = Math.round(pops.reduce((a, b) => a + b, 0) / pops.length);
      }
    }

    // Prepare time series data (last 30 days)
    const last30Days = [];
    const today = new Date();
    
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      
      // Count bookings for this day
      const dayBookings = bookingDates.filter(bookingDate => {
        if (!bookingDate || isNaN(bookingDate.getTime())) return false;
        return bookingDate.toDateString() === date.toDateString();
      }).length;
      
      last30Days.push({ date: dateStr, count: dayBookings });
    }
    
    const stats = {
      totalBookings,
      totalReleases,
      currentPopulation,
      avgPopulation,
      commonCharges,
      bookingsByDay,
      avgStayDays,
      releaseTypes: finalReleaseTypes,
      timeSeriesData: last30Days,
      dataCollectionStart: dataCollectionStart ? dataCollectionStart.toLocaleDateString('en-US') : null,
      daysOfData,
      totalBailThisMonth,
      avgBailByCharge,
      avgTimeServedMins,
      minTimeServedMins,
      maxTimeServedMins,
      longestInmate,
      longestCurrentMins: longestInmate ? Math.round(longestDays * 24 * 60) : 0,
    };
    
    res.send(getStatsHTML(stats));
    
  } catch (error) {
    console.error('Stats error:', error);
    res.send('Error generating stats: ' + error.message);
  }
});

const RELEASE_TYPE_NAMES = {
  RBB:  'Released on Bail Bond',
  RPR:  'Released Personal Recognizance',
  ROA:  'Released Own Recognizance',
  RCB:  'Released Cash Bail',
  RCC:  'Released Credit for Time Served',
  RCD:  'Released Court Disposition',
  MIS:  'Mistaken Identity',
  RTR:  'Released to Rehab/Treatment',
  RCT:  'Released Court Order',
  RFTA: 'Released FTA / Dismissed',
  RNCM: 'No Charges Filed',
  RNHM: 'No Hold',
};

function getStatsHTML(stats) {
  const maxCharge = Math.max(...stats.commonCharges.map(c => c.count), 1);
  const maxDay = Math.max(...Object.values(stats.bookingsByDay), 1);

  // ADD THIS ↓↓↓
  const dataBanner = stats.dataCollectionStart ? `
    <div style="background: #2A3828; border-left: 4px solid #C1B09A; padding: 1rem; margin-bottom: 1.5rem; border-radius: 4px;">
      <p style="margin: 0; color: #E5DDD0;">
        📊 Data collection started: <strong>${stats.dataCollectionStart}</strong> 
        (${stats.daysOfData} days of tracking)
      </p>
      <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem; color: #FFFFFF;">
        Statistics become more accurate as more data is collected over time.
      </p>
    </div>
  ` : '';
  // ↑↑↑ END OF NEW SECTION
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Statistics Dashboard - Mason County Jail</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
  <style>
    @font-face { font-family: 'Fake Receipt'; src: url('/fonts/FakeReceipt.otf') format('opentype'); font-weight: normal; font-style: normal; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, sans-serif;
      font-size: 9pt;
      background: #191D18;
      color: #C1B09A;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-family: 'Fake Receipt', 'Courier New', monospace;
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      color: #E5DDD0;
      letter-spacing: 1px;
    }
    .subtitle { color: #72807A; margin-bottom: 2rem; }
    .back-link { 
      display: inline-block; 
      margin-bottom: 1.5rem; 
      color: #8A7A68; 
      text-decoration: none; 
    }
    .back-link:hover { text-decoration: underline; }
    
    .stats-grid { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
      gap: 1rem; 
      margin-bottom: 2rem; 
    }
    .stat-card { 
      background: #222C22; 
      border-radius: 12px; 
      padding: 1.5rem; 
      border-left: 4px solid #8A7A68;
    }
    .stat-card.purple { border-left-color: #72807A; }
    .stat-card.blue { border-left-color: #8A7A68; }
    .stat-card.orange { border-left-color: #C1B09A; }
    
    .stat-value { 
      font-size: 2.5rem; 
      font-weight: bold; 
      color: #C1B09A; 
      margin-bottom: 0.25rem;
    }
    .stat-label { 
      color: #72807A; 
      font-size: 0.875rem; 
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .chart-container { 
      background: #222C22; 
      border-radius: 12px; 
      padding: 1.5rem; 
      margin-bottom: 1rem; 
    }
    .chart-title {
      font-family: 'Fake Receipt', 'Courier New', monospace;
      color: #C1B09A;
      font-size: 1.2rem;
      font-weight: bold;
      margin-bottom: 1rem;
      letter-spacing: 0.5px;
    }
    
    .bar-chart { margin-top: 1rem; }
    .bar-item { 
      display: flex; 
      align-items: center; 
      margin-bottom: 0.75rem; 
    }
    .bar-label { 
      min-width: 200px; 
      color: #FFFFFF; 
      font-size: 0.8rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-fill { 
      background: linear-gradient(90deg, #8A7A68, #C1B09A); 
      height: 24px; 
      border-radius: 4px; 
      display: flex; 
      align-items: center; 
      padding: 0 0.5rem; 
      color: #fff; 
      font-weight: bold; 
      font-size: 0.75rem;
      min-width: 30px;
    }
    
    .day-chart { 
      display: flex; 
      gap: 0.5rem; 
      align-items: flex-end; 
      height: 200px; 
      margin-top: 1rem;
    }
    .day-bar { 
      flex: 1; 
      display: flex; 
      flex-direction: column; 
      align-items: center; 
      justify-content: flex-end;
    }
    .day-bar-fill { 
      width: 100%; 
      background: linear-gradient(180deg, #8A7A68, #C1B09A);
      border-radius: 4px 4px 0 0;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      color: #fff;
      font-size: 0.7rem;
      font-weight: bold;
      padding-bottom: 0.25rem;
    }
    .day-label { 
      color: #72807A; 
      font-size: 0.75rem; 
      margin-top: 0.5rem; 
    }
    
    .release-types { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); 
      gap: 1rem; 
      margin-top: 1rem;
    }
    .release-type { 
      background: #0E1410; 
      padding: 1rem; 
      border-radius: 8px; 
      text-align: center;
    }
    .release-type-count { 
      font-size: 1.5rem; 
      font-weight: bold; 
      color: #C1B09A; 
    }
    .release-type-label { 
      color: #72807A; 
      font-size: 0.75rem; 
      margin-top: 0.25rem;
    }

    .time-series {
      display: flex;
      gap: 2px;
      align-items: flex-end;
      height: 150px;
      margin-top: 1rem;
    }
    .time-bar {
      flex: 1;
      background: linear-gradient(180deg, #8A7A68, #C1B09A);
      border-radius: 2px 2px 0 0;
      position: relative;
      min-width: 8px;
    }
    .time-bar:hover {
      background: linear-gradient(180deg, #C1B09A, #8A7A68);
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/status" class="back-link">← Back to Status</a>
    <h1>Statistics Dashboard</h1>
    <p class="subtitle">Mason County Jail Roster Analytics</p>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.totalBookings.toLocaleString()}</div>
        <div class="stat-label">Total Bookings Tracked</div>
      </div>
      <div class="stat-card purple">
        <div class="stat-value">${stats.totalReleases.toLocaleString()}</div>
        <div class="stat-label">Total Releases Tracked</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-value">${stats.currentPopulation}</div>
        <div class="stat-label">Current Population</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-value">${stats.avgPopulation}</div>
        <div class="stat-label">Avg Daily Population</div>
      </div>
    </div>

    <div class="chart-container">
      <div class="chart-title">Bookings Over Last 30 Days</div>
      <div class="time-series">
        ${stats.timeSeriesData.map(d => {
          const maxCount = Math.max(...stats.timeSeriesData.map(x => x.count), 1);
          const height = (d.count / maxCount) * 100;
          return `<div class="time-bar" style="height: ${height}%" title="${d.date}: ${d.count} booking${d.count !== 1 ? 's' : ''}"></div>`;
        }).join('')}
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart-title">Most Common Charges</div>
      <div class="bar-chart">
        ${stats.commonCharges.map(item => `
          <div class="bar-item">
            <div class="bar-label">${item.charge}</div>
            <div class="bar-fill" style="width: ${(item.count / maxCharge) * 300}px;">
              ${item.count}
            </div>
          </div>
        `).join('')}
        ${stats.commonCharges.length === 0 ? '<p style="color: #72807A;">No charge data available yet</p>' : ''}
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart-title">Bookings by Day of Week</div>
      <div class="day-chart">
        ${Object.entries(stats.bookingsByDay).map(([day, count]) => `
          <div class="day-bar">
            <div class="day-bar-fill" style="height: ${(count / maxDay) * 180}px;">
              ${count > 0 ? count : ''}
            </div>
            <div class="day-label">${day}</div>
          </div>
        `).join('')}
      </div>
    </div>

    ${Object.keys(stats.releaseTypes).length > 0 ? `
<div class="chart-container">
  <div class="chart-title">Release Type Breakdown</div>
  <div class="release-types">
    ${Object.entries(stats.releaseTypes)
      .filter(([code]) => Object.prototype.hasOwnProperty.call(RELEASE_TYPE_NAMES, code))
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `
      <div class="release-type">
        <div class="release-type-count">${count}</div>
        <div style="font-size: 1rem; font-weight: bold; color: #C1B09A; margin: 0.25rem 0;">${code}</div>
        <div class="release-type-label">${RELEASE_TYPE_NAMES[code] || code}</div>
      </div>
    `).join('')}
  </div>

</div>` : ''}

    ${stats.avgTimeServedMins > 0 ? `
    <div class="chart-container">
      <div class="chart-title">Time Served Statistics (from PDF Data)</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-top: 1rem;">
        <div style="background: #0E1410; padding: 1rem; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5rem; font-weight: bold; color: #C1B09A;">${formatMinutes(stats.avgTimeServedMins)}</div>
          <div style="color: #72807A; font-size: 0.75rem; margin-top: 0.25rem;">Average Time Served</div>
        </div>
        <div style="background: #0E1410; padding: 1rem; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5rem; font-weight: bold; color: #C1B09A;">${formatMinutes(stats.minTimeServedMins)}</div>
          <div style="color: #72807A; font-size: 0.75rem; margin-top: 0.25rem;">Shortest Stay</div>
        </div>
        <div style="background: #0E1410; padding: 1rem; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5rem; font-weight: bold; color: #C1B09A;">${stats.longestCurrentMins > 0 ? formatMinutes(stats.longestCurrentMins) : 'N/A'}</div>
          <div style="color: #72807A; font-size: 0.75rem; margin-top: 0.25rem;">Longest Current Stay</div>
          ${stats.longestInmate ? `<div style="color: #72807A; font-size: 0.65rem; margin-top: 0.2rem;">${stats.longestInmate.name}</div>` : ''}
        </div>
      </div>
    </div>` : ''}

    ${ /* TODO: re-enable Average Bail by Charge Type in a few weeks (data still being collected via avgBailByCharge)
    stats.avgBailByCharge.length > 0 ? `
    <div class="chart-container">
      <div class="chart-title">Average Bail by Charge Type</div>
      <div class="bar-chart">
        ${(() => {
          const maxBail = Math.max(...stats.avgBailByCharge.map(x => x.avgBail), 1);
          return stats.avgBailByCharge.map(item => `
            <div class="bar-item">
              <div class="bar-label">${item.charge}</div>
              <div class="bar-fill" style="width: ${(item.avgBail / maxBail) * 300}px; background: linear-gradient(90deg, #4E5A58, #C1B09A);">
                $${item.avgBail.toLocaleString()}
              </div>
            </div>
          `).join('');
        })()}
      </div>
    </div>` : ''
    */ ''}

  </div>
</body>
</html>`;
}

// ── DEEP STATS (unlisted admin page) ─────────────────────────────────────────
app.get('/api/deepstats', async (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');

    // Load history
    let history = [];
    if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
      try { history = JSON.parse(fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8')); } catch (e) {}
    }

    // Build name→charges and booked-names list from change log
    const nameToCharges = new Map();
    const bookedNamesList = [];
    if (fs.existsSync(logFile)) {
      for (const line of fs.readFileSync(logFile, 'utf-8').split('\n')) {
        if (line.startsWith('BOOKED |')) {
          const nm = line.match(/BOOKED \| ([^|]+) \|/);
          const ch = line.match(/Charges:\s+(.+)/);
          if (nm) {
            const name = nm[1].trim();
            bookedNamesList.push(name);
            if (ch && !nameToCharges.has(name)) {
              const charges = ch[1].split(',').map(c => c.trim()).filter(c => c && c !== 'None listed');
              if (charges.length) nameToCharges.set(name, charges);
            }
          }
        }
      }
    }

    const now = new Date();
    const todayStr = now.toDateString();
    const weekAgo  = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart  = new Date(now.getFullYear(), 0, 1);

    // ── Release type stats ────────────────────────────────────────────────────
    const rtStats = {}; // code → { count, totalMins, totalBail, bailCount }
    for (const e of history) {
      const code = e.releaseType || 'UNK';
      if (!rtStats[code]) rtStats[code] = { count: 0, totalMins: 0, totalBail: 0, bailCount: 0 };
      rtStats[code].count++;
      const ts = (e.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
      if (ts) {
        const m = parseInt(ts[1])*1440 + parseInt(ts[2])*60 + parseInt(ts[3]);
        if (m > 0 && m < 525600) rtStats[code].totalMins += m;
      }
      const bail = parseFloat((e.bail || '$0').replace(/[$,]/g, ''));
      if (bail > 0) { rtStats[code].totalBail += bail; rtStats[code].bailCount++; }
    }

    // ── Bail stats ────────────────────────────────────────────────────────────
    let bailToday=0, bailWeek=0, bailMonth=0, bailYTD=0, bailCount=0, noBailCount=0;
    let maxBail=0, maxBailEntry=null;
    const bailLeaderboardRaw = [];

    for (const e of history) {
      const bail = parseFloat((e.bail || '$0').replace(/[$,]/g, ''));
      let rd = null;
      if (e.releaseDateTime) {
        const [dp] = e.releaseDateTime.split(' ');
        const [m, d, y] = dp.split('/');
        rd = new Date(2000 + parseInt(y), parseInt(m)-1, parseInt(d));
      }
      if (bail > 0) {
        bailCount++;
        if (rd) {
          if (rd.toDateString() === todayStr) bailToday += bail;
          if (rd >= weekAgo)    bailWeek  += bail;
          if (rd >= monthStart) bailMonth += bail;
          if (rd >= yearStart)  bailYTD   += bail;
        }
        if (bail > maxBail) { maxBail = bail; maxBailEntry = e; }
        bailLeaderboardRaw.push({ ...e, bailAmt: bail, charges: nameToCharges.get(e.name) || [] });
      } else { noBailCount++; }
    }
    bailLeaderboardRaw.sort((a, b) => b.bailAmt - a.bailAmt);
    const top10Bail = bailLeaderboardRaw.slice(0, 10);

    // ── Per-charge correlations ───────────────────────────────────────────────
    const bailByCharge = {}, timeByCharge = {}, rtByCharge = {};
    for (const e of history) {
      const charges = nameToCharges.get(e.name) || [];
      const bail = parseFloat((e.bail || '$0').replace(/[$,]/g, ''));
      const ts = (e.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
      const mins = ts ? parseInt(ts[1])*1440 + parseInt(ts[2])*60 + parseInt(ts[3]) : 0;
      const type = e.releaseType || 'UNK';
      for (const charge of charges) {
        if (!charge) continue;
        if (bail > 0) {
          if (!bailByCharge[charge]) bailByCharge[charge] = { total:0, count:0, max:0 };
          bailByCharge[charge].total += bail;
          bailByCharge[charge].count++;
          if (bail > bailByCharge[charge].max) bailByCharge[charge].max = bail;
        }
        if (mins > 0 && mins < 525600) {
          if (!timeByCharge[charge]) timeByCharge[charge] = { totalMins:0, count:0 };
          timeByCharge[charge].totalMins += mins;
          timeByCharge[charge].count++;
        }
        if (!rtByCharge[charge]) rtByCharge[charge] = {};
        rtByCharge[charge][type] = (rtByCharge[charge][type] || 0) + 1;
      }
    }

    // ── Time served ───────────────────────────────────────────────────────────
    let under24=0, over24=0, histMaxMins=0, histMaxEntry=null;
    let histMinMins=Infinity, histMinEntry=null;
    for (const e of history) {
      const ts = (e.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
      if (ts) {
        const m = parseInt(ts[1])*1440 + parseInt(ts[2])*60 + parseInt(ts[3]);
        if (m > 0 && m < 525600) {
          if (m < 1440) under24++; else over24++;
          if (m > histMaxMins) { histMaxMins = m; histMaxEntry = e; }
          if (m < histMinMins) { histMinMins = m; histMinEntry = e; }
        }
      }
    }

    // ── Frequent flyers ───────────────────────────────────────────────────────
    const nameCounts = {};
    bookedNamesList.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
    const frequentFlyers = Object.entries(nameCounts)
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => ({ name, count, charges: nameToCharges.get(name) || [] }));

    // ── Busiest release day/time (from history PDF) ───────────────────────────
    const relDays  = { Sun:0, Mon:0, Tue:0, Wed:0, Thu:0, Fri:0, Sat:0 };
    const relHours = Array(24).fill(0);
    for (const e of history) {
      const [dp, tp] = (e.releaseDateTime || '').split(' ');
      if (dp && tp) {
        const [m, d, y] = dp.split('/');
        const dt = new Date(2000 + parseInt(y), parseInt(m)-1, parseInt(d));
        relDays[['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()]]++;
        const hr = parseInt(tp.split(':')[0]);
        if (hr >= 0 && hr < 24) relHours[hr]++;
      }
    }

    // ── Busiest book day/time + current longest (live roster PDF) ─────────────
    const bookDays  = { Sun:0, Mon:0, Tue:0, Wed:0, Thu:0, Fri:0, Sat:0 };
    const bookHours = Array(24).fill(0);
    let currentLongest = null, currentLongestDays = 0;
    try {
      const pdfResp = await fetch(PDF_URL);
      if (pdfResp.ok) {
        const buf = Buffer.from(await pdfResp.arrayBuffer());
        const parsed = await PDFParser(buf);
        for (const [, b] of extractBookings(parsed.text).entries()) {
          if (b.bookDate && b.bookDate !== 'Unknown') {
            const [dp, tp] = b.bookDate.split(' ');
            if (dp && tp) {
              const [bm, bd, by] = dp.split('/');
              const [bh, bmin] = tp.split(':');
              const byr = by.length === 2 ? 2000 + parseInt(by) : parseInt(by);
              const dt = new Date(byr, parseInt(bm)-1, parseInt(bd), parseInt(bh), parseInt(bmin));
              bookDays[['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()]]++;
              const hr = parseInt(bh);
              if (hr >= 0 && hr < 24) bookHours[hr]++;
              const daysIn = (now - dt) / 86400000;
              if (daysIn > currentLongestDays) {
                currentLongestDays = daysIn;
                currentLongest = { name: b.name, days: Math.floor(daysIn), bookDate: b.bookDate, charges: b.charges };
              }
            }
          }
        }
      }
    } catch (e) { console.error('deepstats PDF error:', e); }

    res.send(getDeepStatsHTML({
      history, rtStats, nameToCharges,
      bailToday, bailWeek, bailMonth, bailYTD, bailCount, noBailCount,
      maxBailEntry, top10Bail,
      bailByCharge, timeByCharge, rtByCharge,
      under24, over24,
      histMaxMins, histMaxEntry,
      histMinMins: histMinMins === Infinity ? 0 : histMinMins, histMinEntry,
      frequentFlyers,
      relDays, relHours, bookDays, bookHours,
      currentLongest,
    }));
  } catch (err) {
    console.error('Deep stats error:', err);
    res.status(500).send('Error: ' + err.message + '\n\nStack: ' + err.stack);
  }
});

function getDeepStatsHTML(d) {
  const total = d.history.length;
  const $ = n => '$' + (n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const pct = (n, of) => of > 0 ? ((n/of)*100).toFixed(1) + '%' : '—';

  // Precompute sorted arrays
  const rtArr = Object.entries(d.rtStats)
    .sort((a,b) => b[1].count - a[1].count)
    .map(([code, s]) => ({
      code,
      name: RELEASE_TYPE_NAMES[code] || code,
      count: s.count,
      pct: pct(s.count, total),
      avgTime: s.totalMins > 0 ? formatMinutes(Math.round(s.totalMins / s.count)) : '—',
      avgBail: s.bailCount > 0 ? $(Math.round(s.totalBail / s.bailCount)) : '—',
    }));

  const bailByChargeArr = Object.entries(d.bailByCharge)
    .map(([charge, s]) => ({ charge, avg: Math.round(s.total/s.count), max: s.max, count: s.count }))
    .sort((a,b) => b.max - a.max).slice(0, 12);

  const timeByChargeArr = Object.entries(d.timeByCharge)
    .map(([charge, s]) => ({ charge, avgMins: Math.round(s.totalMins/s.count), count: s.count }))
    .sort((a,b) => b.avgMins - a.avgMins).slice(0, 12);

  const rtByChargeArr = Object.entries(d.rtByCharge)
    .map(([charge, types]) => {
      const tot = Object.values(types).reduce((a,b)=>a+b,0);
      const top = Object.entries(types).sort((a,b)=>b[1]-a[1]);
      return { charge, total: tot, top };
    })
    .sort((a,b) => b.total - a.total).slice(0, 10);

  const maxRelDay = Math.max(...Object.values(d.relDays), 1);
  const maxRelHour = Math.max(...d.relHours, 1);
  const maxBookDay = Math.max(...Object.values(d.bookDays), 1);
  const maxBookHour = Math.max(...d.bookHours, 1);

  function dayBar(days, max) {
    return Object.entries(days).map(([day, count]) => `
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:4px;">
        <span style="min-width:32px;color:#FFFFFF;font-size:0.75rem;">${day}</span>
        <div style="background:linear-gradient(90deg,#8A7A68,#C1B09A);height:18px;width:${Math.round((count/max)*260)}px;border-radius:3px;min-width:2px;"></div>
        <span style="color:#C1B09A;font-size:0.75rem;">${count}</span>
      </div>`).join('');
  }

  function hourBar(hours, max) {
    return hours.map((count, hr) => `
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:2px;">
        <span style="min-width:40px;color:#FFFFFF;font-size:0.7rem;">${String(hr).padStart(2,'0')}:00</span>
        <div style="background:linear-gradient(90deg,#2A3828,#3A4E38);height:14px;width:${Math.round((count/max)*260)}px;border-radius:2px;min-width:2px;"></div>
        <span style="color:#FFFFFF;font-size:0.7rem;">${count}</span>
      </div>`).join('');
  }

  return `<!DOCTYPE html>
<html>
<head>
  <title>Deep Stats — Mason County Jail</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Liberation Sans',monospace;font-size:8.5pt;background:#0E1410;color:#FFFFFF;padding:2rem;min-height:100vh}
    .wrap{max-width:1100px;margin:0 auto}
    h1{font-size:1.4rem;color:#E5DDD0;margin-bottom:0.25rem;letter-spacing:-0.5px}
    h2{font-size:0.85rem;color:#8A7A68;text-transform:uppercase;letter-spacing:1px;margin:2rem 0 0.75rem;border-bottom:1px solid #2A3828;padding-bottom:0.4rem}
    a{color:#8A7A68;text-decoration:none}
    .subtitle{color:#72807A;font-size:0.75rem;margin-bottom:2rem}
    table{width:100%;border-collapse:collapse;font-size:0.8rem;margin-top:0.5rem}
    th{color:#72807A;text-align:left;padding:0.4rem 0.5rem;border-bottom:1px solid #2A3828;font-weight:normal;text-transform:uppercase;font-size:0.7rem;letter-spacing:0.5px}
    td{padding:0.35rem 0.5rem;border-bottom:1px solid #0E1812;color:#FFFFFF;vertical-align:top}
    tr:hover td{background:#0E1812}
    .val{color:#C1B09A;font-weight:bold}
    .dim{color:#72807A}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem;margin-top:0.75rem}
    .card{background:#222C22;border-radius:8px;padding:1rem;border-left:3px solid #8A7A68}
    .card .v{font-size:1.6rem;font-weight:bold;color:#C1B09A}
    .card .l{color:#72807A;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;margin-top:0.15rem}
    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
    @media(max-width:700px){.two-col{grid-template-columns:1fr}}
    .chip{display:inline-block;background:#0E1812;border:1px solid #283C2A;padding:1px 6px;border-radius:3px;font-size:0.7rem;margin:1px;color:#FFFFFF}
  </style>
</head>
<body>
<div class="wrap">
  <a href="/api/status" style="font-size:0.75rem;color:#72807A;">← status</a>
  <h1 style="margin-top:0.5rem;">Deep Analytics</h1>
  <p class="subtitle">Mason County Jail · ${total} releases in history · Unlisted</p>

  <h2>Release Type Breakdown</h2>
  <table>
    <tr><th>Code</th><th>Name</th><th>Count</th><th>%</th><th>Avg Time Served</th><th>Avg Bail (if any)</th></tr>
    ${rtArr.map(r => `<tr>
      <td class="val">${r.code}</td>
      <td>${r.name}</td>
      <td>${r.count}</td>
      <td>${r.pct}</td>
      <td>${r.avgTime}</td>
      <td>${r.avgBail}</td>
    </tr>`).join('')}
    ${rtArr.length === 0 ? '<tr><td colspan="6" class="dim">No data yet — run /api/run first</td></tr>' : ''}
  </table>

  <h2>Bail Summary</h2>
  <div class="cards">
    <div class="card"><div class="v">${$( d.bailToday)}</div><div class="l">Today</div></div>
    <div class="card"><div class="v">${$(d.bailWeek)}</div><div class="l">Last 7 Days</div></div>
    <div class="card"><div class="v">${$(d.bailMonth)}</div><div class="l">This Month</div></div>
    <div class="card"><div class="v">${$(d.bailYTD)}</div><div class="l">Year to Date</div></div>
    <div class="card" style="border-left-color:#1a6e3c"><div class="v">${d.bailCount}</div><div class="l">Paid Bail</div></div>
    <div class="card" style="border-left-color:#6e1a1a"><div class="v">${d.noBailCount}</div><div class="l">Zero-Dollar Releases</div></div>
    <div class="card" style="border-left-color:#4a4a00">
      <div class="v">${d.bailCount + d.noBailCount > 0 ? pct(d.bailCount, d.bailCount + d.noBailCount) : '—'}</div>
      <div class="l">Bail vs No-Bail Ratio</div>
    </div>
    ${d.maxBailEntry ? `<div class="card" style="border-left-color:#6e3c1a">
      <div class="v" style="font-size:1.2rem;">${$(d.maxBailEntry.bailAmt || parseFloat((d.maxBailEntry.bail||'$0').replace(/[$,]/g,'')))}</div>
      <div class="l">Most Expensive Bail Ever</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#FFFFFF;">${d.maxBailEntry.name}</div>
    </div>` : ''}
  </div>

  <h2>Top 10 Bail Leaderboard</h2>
  <table>
    <tr><th>#</th><th>Name</th><th>Bail</th><th>Type</th><th>Released</th><th>Charges</th></tr>
    ${d.top10Bail.map((e, i) => `<tr>
      <td class="dim">${i+1}</td>
      <td class="val">${e.name}</td>
      <td style="color:#C1B09A;font-weight:bold;">${$(e.bailAmt)}</td>
      <td><span class="chip">${e.releaseType || '?'}</span></td>
      <td class="dim">${e.releaseDateTime || '—'}</td>
      <td style="font-size:0.7rem;">${e.charges.length ? e.charges.join(', ') : '<span class="dim">—</span>'}</td>
    </tr>`).join('')}
    ${d.top10Bail.length === 0 ? '<tr><td colspan="6" class="dim">No bail data yet</td></tr>' : ''}
  </table>

  <h2>Average &amp; Max Bail by Charge Type</h2>
  <table>
    <tr><th>Charge</th><th>Avg Bail</th><th>Highest Bail</th><th>Count</th></tr>
    ${bailByChargeArr.map(r => `<tr>
      <td>${r.charge}</td>
      <td class="val">${$(r.avg)}</td>
      <td style="color:#C1B09A;">${$(r.max)}</td>
      <td class="dim">${r.count}</td>
    </tr>`).join('')}
    ${bailByChargeArr.length === 0 ? '<tr><td colspan="4" class="dim">No data yet</td></tr>' : ''}
  </table>

  <h2>Average Time Served by Charge</h2>
  <table>
    <tr><th>Charge</th><th>Avg Time Served</th><th>Count</th></tr>
    ${timeByChargeArr.map(r => `<tr>
      <td>${r.charge}</td>
      <td class="val">${formatMinutes(r.avgMins)}</td>
      <td class="dim">${r.count}</td>
    </tr>`).join('')}
    ${timeByChargeArr.length === 0 ? '<tr><td colspan="3" class="dim">No data yet</td></tr>' : ''}
  </table>

  <h2>Release Type by Charge</h2>
  <table>
    <tr><th>Charge</th><th>Total</th><th>Top Release Type</th><th>Full Breakdown</th></tr>
    ${rtByChargeArr.map(r => `<tr>
      <td>${r.charge}</td>
      <td class="dim">${r.total}</td>
      <td><span class="chip">${r.top[0][0]}</span> <span class="dim">${r.top[0][1]}×</span></td>
      <td style="font-size:0.7rem;">${r.top.map(([code, cnt]) => `<span class="chip">${code} ${cnt}</span>`).join(' ')}</td>
    </tr>`).join('')}
    ${rtByChargeArr.length === 0 ? '<tr><td colspan="4" class="dim">No data yet</td></tr>' : ''}
  </table>

  <h2>Time Served Statistics</h2>
  <div class="cards">
    <div class="card">
      <div class="v">${d.under24 + d.over24 > 0 ? pct(d.under24, d.under24+d.over24) : '—'}</div>
      <div class="l">Released in &lt;24 Hours</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#72807A;">${d.under24} under / ${d.over24} over</div>
    </div>
    ${d.histMinEntry ? `<div class="card" style="border-left-color:#1a6e3c">
      <div class="v" style="font-size:1.2rem;">${formatMinutes(d.histMinMins)}</div>
      <div class="l">Shortest Stay Ever</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#FFFFFF;">${d.histMinEntry.name}</div>
    </div>` : ''}
    ${d.histMaxEntry ? `<div class="card" style="border-left-color:#6e1a1a">
      <div class="v" style="font-size:1.2rem;">${formatMinutes(d.histMaxMins)}</div>
      <div class="l">Historical Longest Stay</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#FFFFFF;">${d.histMaxEntry.name}</div>
    </div>` : ''}
    ${d.currentLongest ? `<div class="card" style="border-left-color:#6e3c1a">
      <div class="v" style="font-size:1.2rem;">${d.currentLongest.days}d</div>
      <div class="l">Current Longest Stay</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#FFFFFF;">${d.currentLongest.name}</div>
      <div style="font-size:0.65rem;color:#72807A;">In since ${d.currentLongest.bookDate}</div>
    </div>` : ''}
  </div>

  <h2>Frequent Flyers (Booked 2+ Times)</h2>
  <table>
    <tr><th>Name</th><th>Bookings</th><th>Charges</th></tr>
    ${d.frequentFlyers.map(f => `<tr>
      <td class="val">${f.name}</td>
      <td style="color:#C1B09A;text-align:center;">${f.count}</td>
      <td style="font-size:0.7rem;">${f.charges.length ? f.charges.join(', ') : '<span class="dim">—</span>'}</td>
    </tr>`).join('')}
    ${d.frequentFlyers.length === 0 ? '<tr><td colspan="3" class="dim">No repeat bookings yet</td></tr>' : ''}
  </table>

  <h2>Busiest Release Times (from 48hr PDF)</h2>
  <div class="two-col">
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Day of Week</p>
      ${dayBar(d.relDays, maxRelDay)}
    </div>
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Hour of Day</p>
      ${hourBar(d.relHours, maxRelHour)}
    </div>
  </div>

  <h2>Busiest Booking Times (from live roster PDF)</h2>
  <div class="two-col">
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Day of Week</p>
      ${dayBar(d.bookDays, maxBookDay)}
    </div>
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Hour of Day</p>
      ${hourBar(d.bookHours, maxBookHour)}
    </div>
  </div>

  <h2>Release Type Definitions</h2>
  <table>
    <tr><th>Code</th><th>Meaning</th></tr>
    <tr><td class="val">RBB</td><td>Released on Bail Bond — a bail bondsman posted a surety bond on behalf of the inmate</td></tr>
    <tr><td class="val">RPR</td><td>Released on Personal Recognizance — released on a signed promise to appear; no money required</td></tr>
    <tr><td class="val">ROA</td><td>Released on Own Recognizance — same as RPR; released without bail on promise to appear</td></tr>
    <tr><td class="val">RCB</td><td>Released on Cash Bail — full bail amount paid in cash directly to the jail or court</td></tr>
    <tr><td class="val">RCC</td><td>Released — Credit for Time Served — sentence satisfied by time already spent in custody</td></tr>
    <tr><td class="val">RCD</td><td>Released — Court Disposition — released following a court ruling or final case disposition</td></tr>
    <tr><td class="val">RCT</td><td>Released by Court Order — judge issued a specific order to release the inmate</td></tr>
    <tr><td class="val">RFTA</td><td>Released — FTA / Dismissed — charges dismissed or failure-to-appear warrant resolved</td></tr>
    <tr><td class="val">RNCM</td><td>Released — No Charges Filed — prosecutor declined to file; inmate released without charges</td></tr>
    <tr><td class="val">RNHM</td><td>Released — No Hold — no active hold or detainer; no legal basis to continue detention</td></tr>
    <tr><td class="val">MIS</td><td>Released — Mistaken Identity — wrong person was arrested or booked</td></tr>
    <tr><td class="val">RTR</td><td>Released to Rehab/Treatment — transferred to a treatment or rehabilitation program</td></tr>
  </table>

</div>
</body>
</html>`;
}

// ... all your other routes above ...

app.get('/api/delete-logs', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    const dataDir = path.join(__dirname, 'data');
    
    // Check if directory exists first
    try {
      await fs.access(dataDir);
    } catch {
      return res.send('Data directory does not exist - nothing to delete');
    }
    
    const files = await fs.readdir(dataDir);
    
    if (files.length === 0) {
      return res.send('Data directory is already empty');
    }
    
    let deleted = [];
    for (const file of files) {
      try {
        await fs.unlink(path.join(dataDir, file));
        deleted.push(file);
      } catch (err) {
        console.error(`Failed to delete ${file}:`, err);
      }
    }
    
    res.send(`Deleted ${deleted.length} files: ${deleted.join(', ')}`);
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/api/admin/fix-releases', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    
    let fixed = 0;
    let currentDate = null;
    const fixedLines = [];
    
    for (const line of lines) {
      // Track the current date context from ANY dated entry (BOOKED or RELEASED with valid dates)
      const dateMatch = line.match(/(?:Booked|Released):\s+(\d{2}\/\d{2}\/\d{2})\s+\d{2}:\d{2}:\d{2}/);
      if (dateMatch) {
        currentDate = dateMatch[1];
      }
      
      // Also check for release dates without times (like "Released: 02/09/26")
      const releaseDateOnlyMatch = line.match(/Released:\s+(\d{2}\/\d{2}\/\d{2})(?:\s|$|\|)/);
      if (releaseDateOnlyMatch && !line.includes('00:00:00')) {
        currentDate = releaseDateOnlyMatch[1];
      }
      
      // Fix broken RELEASED entries
      if (line.includes('RELEASED |') && line.includes('Released: Not Released')) {
        if (currentDate) {
          // Replace "Released: Not Released" with "Released: DATE 00:00:00"
          const fixedLine = line.replace('Released: Not Released', `Released: ${currentDate} 00:00:00`);
          fixedLines.push(fixedLine);
          fixed++;
        } else {
          // No date context available, keep the line as-is
          fixedLines.push(line);
        }
      } else {
        fixedLines.push(line);
      }
    }
    
    // Backup original
    fs.writeFileSync(logFile + '.backup-' + Date.now(), content);
    
    // Write fixed version
    fs.writeFileSync(logFile, fixedLines.join('\n'));
    
    res.json({
      success: true,
      fixed: fixed,
      message: `Fixed ${fixed} release entries. Original backed up.`
    });
    
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Admin page for merging old logs
app.get('/api/admin/merge', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Merge Old Logs</title>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial; background: #191D18; color: #C1B09A; padding: 2rem; }
    .container { max-width: 800px; margin: 0 auto; }
    textarea { width: 100%; height: 400px; background: #222C22; color: #C1B09A; border: 1px solid #283C2A; padding: 1rem; font-family: monospace; font-size: 10pt; }
    button { background: #8A7A68; color: #fff; border: none; padding: 1rem 2rem; font-size: 1rem; cursor: pointer; border-radius: 8px; margin-top: 1rem; }
    button:hover { background: #C1B09A; }
    .result { margin-top: 1rem; padding: 1rem; background: #222C22; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Merge Old Change Logs</h1>
    <p>Paste your old change log text below and click Merge</p>
    <textarea id="logText" placeholder="Paste old change log entries here..."></textarea>
    <button onclick="mergeLogs()">Merge Logs</button>
    <div id="result" class="result" style="display:none;"></div>
  </div>
  <script>
    async function mergeLogs() {
      const text = document.getElementById('logText').value;
      if (!text.trim()) {
        alert('Please paste some log text first');
        return;
      }
      
      const response = await fetch('/api/admin/merge-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text
      });
      
      const result = await response.json();
      const resultDiv = document.getElementById('result');
      resultDiv.style.display = 'block';
      
      if (result.success) {
        resultDiv.innerHTML = '✓ Success! Old logs merged. <a href="/api/stats" style="color: #8A7A68;">View Stats Dashboard</a>';
        document.getElementById('logText').value = '';
      } else {
        resultDiv.innerHTML = '✗ Error: ' + result.error;
      }
    }
  </script>
</body>
</html>`);
});

app.post('/api/admin/merge-logs', (req, res) => {
  try {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      const logFile = path.join(STORAGE_DIR, 'change_log.txt');
      
      // Append old content to current log
      fs.appendFileSync(logFile, '\n' + body);
      
      res.json({ success: true, message: 'Old logs merged successfully!' });
    });
    
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// View full change log
app.get('/api/admin/view-log', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      res.setHeader('Content-Type', 'text/plain');
      res.send(content);
    } else {
      res.send('No log file found');
    }
  } catch (error) {
    res.send('Error: ' + error.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit: http://localhost:${PORT}`);

  // Auto-run roster check every 30 minutes
  const RUN_INTERVAL_MS = 30 * 60 * 1000;
  const autoRun = () => {
    fetch(`http://localhost:${PORT}/api/run`)
      .then(r => r.text())
      .then(t => console.log(`[auto-run] ${new Date().toISOString()} — ${t.slice(0, 120)}`))
      .catch(e => console.error(`[auto-run error] ${new Date().toISOString()} —`, e.message));
  };
  setInterval(autoRun, RUN_INTERVAL_MS);
  console.log(`[auto-run] scheduled every 30 minutes`)
});

app.get('/api/debug/charge-lines', async (req, res) => {
  try {
    const response = await fetch(PDF_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;
    
    const blocks = text.split(/(?=Booking #:)/);
    const firstBlock = blocks.find(b => b.includes("Booking #:"));
    
    if (!firstBlock) {
      return res.json({ error: 'No booking blocks found' });
    }
    
    const lines = firstBlock.split("\n");
    let inCharges = false;
    const chargeLines = [];
    const allLinesAfterHeader = [];
    
    for (const line of lines) {
      const t = line.trim();
      
      if (t === "StatuteOffenseCourtOffenseClass") {
        inCharges = true;
        continue;
      }
      
      if (t.startsWith("Booking #:")) {
        break;
      }
      
      if (inCharges) {
        allLinesAfterHeader.push(t);
        
        if (t.includes('SUPR') || t.includes('DIST') || t.includes('MUNI') || t.includes('DOC')) {
          chargeLines.push(t);
        }
      }
    }
    
    res.json({
      foundHeader: allLinesAfterHeader.length > 0,
      allLinesAfterHeader: allLinesAfterHeader.slice(0, 20),
      chargeLines: chargeLines
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

