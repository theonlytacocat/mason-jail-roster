import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import PDFParser from 'pdf-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PDF_URL = 'https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf';
const RELEASE_STATS_URL = 'https://hub.masoncountywa.gov/sheriff/reports/release_stats48hrs.pdf';
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';

// Ensure storage directory exists
function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}
ensureStorageDir();

// Parse release stats PDF
async function fetchReleaseStats() {
  try {
    const response = await fetch(RELEASE_STATS_URL);
    if (!response.ok) return new Map();
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;
    
    const releaseMap = new Map();
    const lines = text.split('\n');
    
    for (const line of lines) {
      // Match: Date/Time | Name | Release Type | Credit Served | Bail
      // Handle names with periods like "ALLEN, HAROLD F. III"
      const match = line.match(/(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([A-Z][A-Z\s,.'"-]+?)\s+\.\s*(R[A-Z]{2,3})\s+(\d+\s*d\s*\d+\s*h\s*\d+\s*m)\s+\$?([\d,]+\.\d{2})/);
      
      if (match) {
        const [, date, time, name, releaseType, timeServed, bail] = match;
        // Clean up name - remove trailing periods and extra spaces
        const cleanName = name.trim().replace(/\.\s*$/, '').replace(/\s+/g, ' ');
        
        releaseMap.set(cleanName, {
          releaseDateTime: `${date} ${time}`,
          releaseType,
          timeServed: timeServed.replace(/\s+/g, ''),
          bail: `$${bail}`
        });
      }
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
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 8pt; background: #181818; color: #c590d9; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 500px; padding: 2rem; }
    h1 { font-family: 'Noto Serif', sans-serif; font-size: 2rem; margin-bottom: 1.5rem; color: #b8b8b8; letter-spacing: -4px; }
    .status { background: #000; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; }
    .status-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
    .status-dot { width: 12px; height: 12px; background: #33ff00; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .status-title { font-weight: 600; }
    .stats { display: grid; gap: 1rem; }
    .stat { display: flex; justify-content: space-between; padding: 0.75rem 0; border-bottom: 1px solid #334155; }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #94b8b5; }
    .stat-value { font-weight: 500; }
    .run-btn { display: block; width: 100%; padding: 0.75rem; margin-top: 1rem; background: #333a2c; color: #fff; text-align: center; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .run-btn:hover { background: #c590d9; }
    .footer { text-align: center; color: #4c6e60; font-size: 0.875rem; margin-top: 1.5rem; }
    a { color: #353726; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Mason County Jail Roster Monitor</h1>
    <div class="status">
      <div class="status-header">
        <div class="status-dot"></div>
        <span class="status-title">System Active</span>
      </div>
      <div class="stats">
        <div class="stat">
          <span class="stat-label">Last Check</span>
          <span class="stat-value">${lastCheck !== "Never" ? new Date(lastCheck).toLocaleString("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }) + " PST" : "Never"}</span>
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
      <a href="/api/run" class="run-btn">Run Check Now</a>
      <a href="/api/history" class="run-btn" style="margin-top: 0.75rem; background: #333a2c;">View Change History</a>
      <a href="/api/stats" class="run-btn" style="margin-top: 0.75rem; background: #411844;">*NEW* Statistics Dashboard</a>
    </div>
    <div class="footer">
      <p><a href="/api/history">View Change History</a></p>
      <p style="margin-top: 0.5rem;">Monitoring <a href="https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf" target="_blank">Mason County Jail Roster</a></p>
      <a href="/legislative" style="display: inline-block; margin-top: 1rem; padding: 0.5rem 1rem; background: #ec00ff; color: #000000; border-radius: 6px; text-decoration: none; font-size: 0.75rem;">**NEW** 2-9-26 Washington State Legislative Session News Update</a>
    </div>
  </div>
</body>
</html>`;

  res.send(html);
});

// Helper function to extract date from log line
function extractDateFromLine(line) {
  // Extract date from line like "Name | Booked: 01/18/26 01:45:00 | Charges: ..."
  const match = line.match(/Booked:\s+(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (match) {
    // Convert "01/18/26 01:45:00" to Date object
    const [dateStr, timeStr] = match[1].split(' ');
    const [month, day, year] = dateStr.split('/');
    const [hours, minutes, seconds] = timeStr.split(':');
    
    // Add 2000 to 2-digit year
    const fullYear = 2000 + parseInt(year);
    
    return new Date(fullYear, parseInt(month) - 1, parseInt(day), 
                   parseInt(hours), parseInt(minutes), parseInt(seconds));
  }
  
  // Also check for "Released:" format
  const releaseMatch = line.match(/Released:\s+(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (releaseMatch) {
    const [dateStr, timeStr] = releaseMatch[1].split(' ');
    const [month, day, year] = dateStr.split('/');
    const [hours, minutes, seconds] = timeStr.split(':');
    
    const fullYear = 2000 + parseInt(year);
    
    return new Date(fullYear, parseInt(month) - 1, parseInt(day), 
                   parseInt(hours), parseInt(minutes), parseInt(seconds));
  }
  
  return new Date(); // Default to current date if parsing fails
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
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/api/status"><style>body{font-family:sans-serif;background:#181818;color:#c590d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.success{color:#5f8a2f;font-size:3rem;margin-bottom:1rem;}h1{color:#b8b8b8;margin-bottom:1rem;}p{color:#94b8b5;}</style></head><body><div class="container"><div class="success">✓</div><h1>Workflow Complete</h1><p>' +
      message +
      "</p><p>Redirecting to status page...</p></div></body></html>";

    res.send(html);
  } catch (error) {
    console.error('Error in /api/run:', error);
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#181818;color:#c590d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.error{color:#ef4444;font-size:3rem;margin-bottom:1rem;}h1{color:#ef4444;margin-bottom:1rem;}p{color:#94a3b8;}a{color:#38bdf8;}</style></head><body><div class="container"><div class="error">✗</div><h1>Error</h1><p>' +
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
    body { font-family: Arial, sans-serif; font-size: 9pt; background: #181818; color: #c590d9; min-height: 100vh; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-family: 'Noto Serif', sans-serif; font-size: 2rem; margin-bottom: 0.5rem; color: #b8b8b8; letter-spacing: -4px; }
    .subtitle { color: #4c6e60; margin-bottom: 2rem; }
    .back-link { display: inline-block; margin-bottom: 1.5rem; color: #353726; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .content { background: #f9c6fd; border-radius: 12px; padding: 2rem; margin-bottom: 1rem; line-height: 1.6; }
    .content h2 { color: #000000; margin-top: 1.5rem; margin-bottom: 0.75rem; font-size: 1.2rem; }
    .content h2:first-child { margin-top: 0; }
    .content h3 { color: #c590d9; margin-top: 1rem; margin-bottom: 0.5rem; font-size: 1rem; }
    .content p { margin-bottom: 0.75rem; color: #94b8b5; }
    .content ul { margin-left: 1.5rem; margin-bottom: 1rem; }
    .content li { margin-bottom: 0.5rem; color: #94b8b5; }
    .update-date { color: #333a2c; font-weight: bold; margin-bottom: 1rem; }
    .content strong { color: #c590d9; }
    a { color: #353726; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/status" class="back-link">← Back to Jail Roster Monitor</a>
    <h1>Washington State Legislative Session</h1>
    <p class="subtitle">2026 Session Updates and Bill Tracking</p>
    
    <div class="content">
      <p class="update-date">Updates: 2/9/2026</p>
      
      <h2>Washington state legislature 2026 - what's actually going on</h2>

      <h3>SESSION STATUS:</h3>
      <ul>
        <li>Day 27+ of 60-day session (started Jan 12, ends ~March 12)</li>
        <li>First Policy Committee Cutoff: February 5 (PASSED)</li>
        <li>House of Origin Fiscal Committee Cutoff: February 9 (TODAY)</li>
        <li>House of Origin Floor Vote Cutoff: February 17</li>
      </ul>

      <h3>POLICE & PUBLIC SAFETY:</h3>
      <p><strong>BAN ON POLICE FACE COVERINGS (SB.5855) - PASSED SENATE</strong> - Would prohibit cops from wearing masks/balaclavas while interacting with public. Sparked by ice raids. Senate passed it Jan 28. Moving to House. Would take effect in June if signed.</p>
      <p><strong>$100 MILLION POLICE HIRING GRANTS (SB.5060)</strong> - Covers 75% of new officer salaries for 36 months. Ferguson's priority. Cities must implement 0.1% sales tax or already have a similar tax to have access to funds.</p>
      <p><strong>SHERIFF/POLICE CHIEF REQUIREMENTS (HB.1399/SB.5974)</strong> - New standards: minimum age would be 25, background checks to be performed, must maintain peace officer certification. Sheriffs union is PISSED, calling it unconstitutional.</p>
      <p><strong>PUBLIC DEFENSE CRISIS (SB.5404)</strong> - Making the state actually fund public defenders. WA is one of only 2 states that doesn't fully fund them, leading to overworked defenders and constitutional violations.</p>
      <p><strong>FLOCK LICENSE PLATE CAMERA REGULATION (SB.5550) - PASSED SENATE</strong> - Senate approved regulations for automated license plate readers Feb 4. Moving to House.</p>
      <p><strong>NO SECRET POLICE ACT</strong> - Requiring law enforcement to be identifiable during arrests.</p>
      <p><strong>BODY CAMERAS FOR ICE ENCOUNTERS (HB.2648) - ADVANCING</strong> - Passed House Community Safety Committee. Requires local police to turn on body cams when encountering federal agents doing immigration enforcement and report encounters to their agency.</p>
      <p><strong>ICE HIRING BAN (HB.2641) - DEAD</strong> - Bill that would've prohibited hiring former federal immigration agents hired under Trump after Jan 20, 2025 died in committee Feb 5.</p>

      <h3>GUN CONTROL:</h3>
      <p><strong>PERMIT TO PURCHASE (HB.1163)</strong> - Requiring state permit before buying firearms, like a dozen other states have.</p>
      <p><strong>EXPANDING GUN-FREE ZONES</strong> and setting <strong>BULK PURCHASE LIMITS</strong>.</p>
      <p><strong>REQUIRING GUN STORAGE IN CARS/HOMES</strong>, as well as more <strong>REGULATIONS FOR GUN DEALERS</strong>.</p>

      <h3>SOCIAL MEDIA & CHILDREN:</h3>
      <p><strong>ADDICTIVE FEEDS BAN (HB.1834/SB.5708) - ADVANCING</strong> - Attorney General Nick Brown's priority. Would ban addictive feeds for minors, prohibit push notifications overnight/during school hours. Modeled on California law that survived 9th Circuit challenge. Stalled in House in 2025 but has renewed momentum.</p>
      <p><strong>PARENTAL CONSENT FOR SOCIAL MEDIA (SB.6111) - DEAD</strong> - Bill requiring parental consent for minors under 17 to create social media accounts died at first cutoff.</p>
      <p><strong>CHILD INFLUENCER PROTECTIONS (HB.2400) - DEAD</strong> - Bill protecting children in monetized online content (family vlogs) died at first cutoff. Would've allowed young adults to request deletion of childhood videos.</p>
      <p><strong>PORNOGRAPHY ACCESS RESTRICTIONS - DEAD</strong> - Bipartisan bill to restrict children's access to online pornography died at first cutoff.</p>

      <h3>EDUCATION:</h3>
      <p><strong>PARENTAL RIGHTS INITIATIVES</strong> - Two super controversial initiatives coming that would give parents access to ALL school curriculum, allow parents to see mental health counseling records from school counselors. Often called a rewrite of last year's controversial HB.1296.</p>
      <p><strong>HOMESCHOOL AGE REQUIREMENT (SB.6261) - DEAD</strong> - Would've lowered homeschool attestation requirement from age 8 to age 6. WA is only state that waits until age 8.</p>

      <h3>CANNABIS:</h3>
      <p><strong>HOME GROW LEGISLATION (HB.1449/SB.6196) - ADVANCING</strong> - Senate Labor & Commerce passed home grow bill Feb 4. Allows adults 21+ to grow 6 plants per person, max 15 per household. Includes controversial amendment allowing local jurisdictions to ban home grow in residential zones. Moving to fiscal committee. WA is currently one of only 4 adult-use states that still criminalizes home grow (and the only one where it's a felony).</p>
      <p><strong>LOCAL CANNABIS TAX (SB.6328) - REANIMATED</strong> - 2025 Republican bill scheduled for hearing Feb 5 in Senate Ways & Means. Would allow counties OR cities (not both) to impose up to 2% additional excise tax on retail cannabis sales for up to 7 years.</p>
      <p><strong>CANNABIS HOSPITALITY EVENTS - ADVANCING</strong> - Referred to House Appropriations. Must advance by Feb 9 fiscal cutoff or be designated NTIB (necessary to implement budget).</p>
      <p><strong>CANNABIS TAX OVERHAUL (HB.2433)</strong> - Would replace WA's 37% excise tax (highest in nation) with weight and THC potency-based rates.</p>
      <p><strong>HIGH-THC CANNABIS TAX INCREASE (HB.2075)</strong> - Would increase excise tax specifically on high-THC products.</p>

      <h3>TAXES AND BUDGETS:</h3>
      <p><strong>MILLIONAIRE INCOME TAX</strong> - Nearly 10% tax on people making over $1 million/year, would raise $3 billion annually. super controversial since WA has never had an income tax and it might violate the state constitution. republicans threatening lawsuits.</p>
      <p><strong>PAYROLL TAX ON HIGH EARNERS (HB.2100)</strong> - 5% tax on employers for employees making over $125k/year to fund "well Washington fund" for healthcare/education/human services.</p>
      <p><strong>HIGHER EDUCATION FUNDING RESET</strong> - 10% tuition cuts for 3 years starting fall 2027, expanding Washington college grant eligibility.</p>
      <p><strong>PAID PROTESTER TAX</strong> - Would tax temporary staffing agencies that provide "paid protesters" at protests.</p>
      <p><strong>BULLION TAX REPEAL (HB.2093)</strong> - Republicans trying to eliminate the sales tax on gold/silver, saying it's driving coin shops out of business.</p>
      <p><strong>REVERSING 2025 TAX INCREASES (HB.2101)</strong> - Rolling back recent tax hikes to keep investment local.</p>

      <h3>ARTIFICIAL INTELLIGENCE - there are so many of them:</h3>
      <p><strong>AI COMPANION CHATBOTS (SB.5984/HB.2225)</strong> - Regulating AI chatbots for minors after child suicides linked to AI. Prohibits romantic partnerships with minors, requires hourly notifications that it's not human. private right of action included. Tech industry is pushing back heavily on this.</p>
      <p><strong>AI IN SCHOOLS (HB.2481/SB.5956)</strong> - Requiring human oversight of AI systems in schools, addressing surveillance, risk scoring, and automated discipline of students. Protecting kids from being flagged by gun detection AI that mistakes chips bags for weapons.</p>
      <p><strong>REGULATIONS FOR AI:</strong> Use in therapy, specifically mental health treatment.</p>
      <p><strong>HEALTH INSURANCE:</strong> Regulating AI insurance authorization decisions for medical procedures.</p>
      <p><strong>TRAINING DATA TRANSPARENCY</strong> - Requiring disclosure of what data is used to train AI models.</p>
      <p><strong>COLLECTIVE BARGAINING AROUND AI</strong> - Allowing unions to negotiate how AI is used in workplaces.</p>
      <p><strong>GROCERY STORE AI SURVEILLANCE</strong> - Regulating facial recognition and surge pricing based on AI.</p>

      <h3>WILDFIRE & ENVIRONMENT:</h3>
      <p><strong>WILDFIRE PREVENTION FUNDING:</strong> Fighting $60 million cut to wildfire resilience budget. $125 million per biennium for forest health.</p>
      <p><strong>CLEAN ENERGY GRID EXPANSION</strong>, as well as a <strong>SEMI TRUCK EMISSIONS CLIMATE PUSH</strong>.</p>

      <h3>HOUSING & DEVELOPMENT:</h3>
      <p><strong>COMMERCIAL TO RESIDENTIAL CONVERSION (SB.6026)</strong> - Governor's priority - allowing mixed-use and residential in commercial zones without rezoning. Abandoned strip malls and big-box stores could become housing.</p>
      <p><strong>SHORT-TERM RENTAL TAX (SB.5576)</strong> - Up to 4% excise tax on Airbnbs to fund affordable housing. Was statewide, amended to let local governments decide. <strong>Airbnb has pumped $4 million into PAC to kill it</strong> - spending 1/5 of what the tax would generate just to prevent local governments from having the option.</p>
      <p><strong>PARKING REFORM</strong> - Already passed in 2025, now implementing rules reducing parking requirements that drive up housing costs.</p>

      <h3>IMMIGRATION AND LABOR:</h3>
      <p><strong>IMMIGRANT WORKER PROTECTIONS (HB.2105/SB.5852)</strong> - Requiring employers to give workers notice if ice does an i-9 audit of legal work status.</p>
      <p><strong>FARMWORKER COLLECTIVE BARGAINING (SB.6045/HB.2409)</strong> - Would bring farmworkers under Public Employment Relations Commission jurisdiction. Farmworkers have been excluded from National Labor Relations Act protections since 1935.</p>
      <p><strong>MINIMUM WAGE $17.13/HOUR</strong> - Already in effect Jan 1, 2026. Highest in the nation. Some cities higher (Seattle $21.63, Seatac $20.74).</p>
      <p><strong>32-HOUR WORKWEEK (HB.2611) - DEAD</strong> - Would've required overtime pay after 32 hours/week. Food, hospitality, and farm industries opposed. San Juan County implemented 32-hour week for county employees in 2023: 18% decrease in sick calls, 216% increase in job applications, $2 million saved.</p>
      <p><strong>STRIKING WORKERS GET UNEMPLOYMENT</strong> - Already in effect. strikers can collect up to 6 weeks of unemployment benefits after strike starts.</p>
      <p><strong>PAID FAMILY LEAVE EXPANSION</strong> - Job protection after only 180 days (down from 12 months). Minimum leave reduced to 4 hours (from 8 hours).</p>
      <p><strong>WORKPLACE VIOLENCE PREVENTION</strong> - Healthcare facilities must investigate violence incidents promptly and update prevention plans annually.</p>
      <p><strong>ISOLATED WORKER PROTECTIONS</strong> - Panic buttons and safety measures for janitors, housekeepers, security guards who work alone.</p>

      <h3>HEALTHCARE & VACCINES:</h3>
      <p><strong>STATE VACCINE AUTHORITY (SB.5967/HB.2242)</strong> - Governor's priority. Allowing WA dept of health to make vaccine recommendations independent of cdc/federal government. Response to trump politicizing CDC, does NOT create new mandates.</p>

      <h3>ALREADY IN EFFECT:</h3>
      <p><strong>MEDICAL DEBT CREDIT REPORTING BAN</strong> - Medical debt can't be reported to credit agencies.</p>
      <p><strong>BLOOD TYPE ON DRIVER'S LICENSE (SB.5689)</strong> - Voluntary blood type info on state IDS.</p>

      <h3>TRANSPORTATION & ROADS:</h3>
      <p><strong>RECKLESS DRIVING REDEFINED (SB.5890)</strong> - 30+ mph over speed limit = reckless driving charge.</p>
      <p><strong>RECKLESS INTERFERENCE WITH EMERGENCY OPERATIONS (HB.2203)</strong> - New driving offense for blocking emergency vehicles.</p>

      <h3>CRIMINAL JUSTICE:</h3>
      <p><strong>POLITICAL AFFILIATION HATE CRIME (SB.5830)</strong> - Making it a Class C felony to assault someone based on their political beliefs.</p>
      <p><strong>JUVENILE DETENTION OVERCROWDING</strong> - Allowing youth transfers to state prisons and community facilities in certain cases.</p>
      <p><strong>EARLY RELEASE FOR YOUTH OFFENDERS</strong> - Allowing people convicted before age 18 to petition for early release at age 24.</p>
      <p><strong>DUI LAB EXPANSION</strong> - Allowing more labs to perform toxicology tests to speed up cases.</p>

      <h3>CONSUMER & BUSINESS ALREADY IN EFFECT:</h3>
      <p><strong>NICOTINE/VAPE TAX</strong> - 95% excise tax on ALL nicotine products including synthetic nicotine, vapes, pouches. A $7 product now costs $15.06 after taxes.</p>
      <p><strong>PLASTIC BAG FEE INCREASE</strong> - Minimum charge raised from 8 cents to 12 cents per bag.</p>

      <h3>RANDOMS:</h3>
      <p><strong>DIAPER CHANGING STATIONS</strong> - Already in effect. Mandatory in all new/remodeled public buildings costing $15k+.</p>
      <p><strong>GRAY WOLF RECLASSIFICATION</strong> - Downgrading from "endangered" to "sensitive" status.</p>
      <p><strong>DISCOVER PASS PRICE HIKE</strong> - Increasing from $30 to $45 for state parks access, would be the first increase in 14 years.</p>

      <p style="margin-top: 2rem; color: #4c6e60; font-style: italic;">For more information, visit <a href="https://leg.wa.gov" target="_blank">leg.wa.gov</a></p>
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

    return '<div class="entry"><div class="entry-header">' + displayDate + '</div>' + 
           bookedHtml + releasedHtml + '</div>';
  }).join('') : 
  '<p class="no-data">No changes recorded yet. Run the workflow to start monitoring.</p>';

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Change History - Mason County Jail Roster Monitor</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 8pt; background: #181818; color: #c590d9; min-height: 100vh; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-family: 'Noto Serif', sans-serif; font-size: 2rem; margin-bottom: 0.5rem; color: #b8b8b8; letter-spacing: -4px; }
    .subtitle { color: #4c6e60; margin-bottom: 2rem; }
    .back-link { display: inline-block; margin-bottom: 1.5rem; color: #353726; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .entry { background: #000; border-radius: 12px; padding: 1rem; margin-bottom: 1rem; }
    .entry.no-change-entry { background: #0a0a0a; padding: 0.75rem; border-left: 3px solid #334155; }
    .entry-header { font-weight: 600; font-size: 10pt; margin-bottom: 0.75rem; color: #c590d9; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; }
    .changes { margin-top: 0.75rem; }
    .changes h4 { font-size: 9pt; margin-bottom: 0.4rem; font-weight: bold; }
    .changes.booked h4 { color: #411844 }
    .changes.released h4 { color: #3e7400; }
    .changes.updated h4 { color: #353726; }
    .changes ul { list-style: none; font-size: 8pt; color: #94b8b5; }
    .changes ul li { padding: 0.2rem 0; border-bottom: 1px solid #334155; }
    .changes ul li:last-child { border-bottom: none; }
    .no-changes { color: #4c6e60; font-style: italic; }
    .no-data { color: #4c6e60; text-align: center; padding: 3rem; }
    a { color: #353726; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/status" class="back-link">← Back to Status</a>
    <h1>Change History</h1>
    <p class="subtitle">Record of all detected changes in the jail roster (newest first)</p>
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
        commonCharges: [],
        bookingsByDay: {},
        avgStayDays: 0,
        releaseTypes: {},
        timeSeriesData: []
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
          const [month, day, year] = dateStr.split('/');
          const fullYear = 2000 + parseInt(year);
          const date = new Date(fullYear, parseInt(month) - 1, parseInt(day));
          bookingDates.push(date);
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
          const [month, day, year] = dateStr.split('/');
          const fullYear = 2000 + parseInt(year);
          const date = new Date(fullYear, parseInt(month) - 1, parseInt(day));
          releaseDates.push(date);
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
      const cleanCharge = charge.trim();
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
    
    // Get current population from roster file
    let currentPopulation = 0;
    const rosterFile = path.join(STORAGE_DIR, 'prev_roster.txt');
    if (fs.existsSync(rosterFile)) {
      const content = fs.readFileSync(rosterFile, 'utf-8');
      const bookingMatches = content.match(/Booking #:/g);
      currentPopulation = bookingMatches ? bookingMatches.length : 0;
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
      commonCharges,
      bookingsByDay,
      avgStayDays,
      releaseTypes,
      timeSeriesData: last30Days
      dataCollectionStart: dataCollectionStart ? dataCollectionStart.toLocaleDateString('en-US') : null,
      daysOfData
    };
    
    res.send(getStatsHTML(stats));
    
  } catch (error) {
    console.error('Stats error:', error);
    res.send('Error generating stats: ' + error.message);
  }
});

function getStatsHTML(stats) {
  const maxCharge = Math.max(...stats.commonCharges.map(c => c.count), 1);
  const maxDay = Math.max(...Object.values(stats.bookingsByDay), 1);
  
  // ADD THIS ↓↓↓
  const dataBanner = stats.dataCollectionStart ? `
    <div style="background: #f0f4f8; border-left: 4px solid #3b82f6; padding: 1rem; margin-bottom: 1.5rem; border-radius: 4px;">
      <p style="margin: 0; color: #1e293b;">
        📊 Data collection started: <strong>${stats.dataCollectionStart}</strong> 
        (${stats.daysOfData} days of tracking)
      </p>
      <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem; color: #64748b;">
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: Arial, sans-serif; 
      font-size: 9pt; 
      background: #181818; 
      color: #c590d9; 
      min-height: 100vh; 
      padding: 2rem; 
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { 
      font-family: 'Noto Serif', sans-serif; 
      font-size: 2rem; 
      margin-bottom: 0.5rem; 
      color: #b8b8b8; 
      letter-spacing: -4px; 
    }
    .subtitle { color: #4c6e60; margin-bottom: 2rem; }
    .back-link { 
      display: inline-block; 
      margin-bottom: 1.5rem; 
      color: #353726; 
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
      background: #000; 
      border-radius: 12px; 
      padding: 1.5rem; 
      border-left: 4px solid #5f8a2f;
    }
    .stat-card.purple { border-left-color: #411844; }
    .stat-card.blue { border-left-color: #353726; }
    .stat-card.orange { border-left-color: #00b9c2; }
    
    .stat-value { 
      font-size: 2.5rem; 
      font-weight: bold; 
      color: #c590d9; 
      margin-bottom: 0.25rem;
    }
    .stat-label { 
      color: #4c6e60; 
      font-size: 0.875rem; 
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .chart-container { 
      background: #000; 
      border-radius: 12px; 
      padding: 1.5rem; 
      margin-bottom: 1rem; 
    }
    .chart-title { 
      color: #333a2c; 
      font-size: 1.1rem; 
      font-weight: bold; 
      margin-bottom: 1rem; 
    }
    
    .bar-chart { margin-top: 1rem; }
    .bar-item { 
      display: flex; 
      align-items: center; 
      margin-bottom: 0.75rem; 
    }
    .bar-label { 
      min-width: 200px; 
      color: #94b8b5; 
      font-size: 0.8rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-fill { 
      background: linear-gradient(90deg, #5f8a2f, #c590d9); 
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
      background: linear-gradient(180deg, #411844, #333a2c); 
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
      color: #4c6e60; 
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
      background: #1a1a1a; 
      padding: 1rem; 
      border-radius: 8px; 
      text-align: center;
    }
    .release-type-count { 
      font-size: 1.5rem; 
      font-weight: bold; 
      color: #c590d9; 
    }
    .release-type-label { 
      color: #4c6e60; 
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
      background: linear-gradient(180deg, #353726, #c590d9);
      border-radius: 2px 2px 0 0;
      position: relative;
      min-width: 8px;
    }
    .time-bar:hover {
      background: linear-gradient(180deg, #333a2c, #411844);
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
      <div class="stat-card orange">
        <div class="stat-value">${stats.avgStayDays} days</div>
        <div class="stat-label">Average Length of Stay</div>
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
        ${stats.commonCharges.length === 0 ? '<p style="color: #4c6e60;">No charge data available yet</p>' : ''}
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
    body { font-family: Arial; background: #181818; color: #c590d9; padding: 2rem; }
    .container { max-width: 800px; margin: 0 auto; }
    textarea { width: 100%; height: 400px; background: #000; color: #c590d9; border: 1px solid #334155; padding: 1rem; font-family: monospace; font-size: 10pt; }
    button { background: #5f8a2f; color: #fff; border: none; padding: 1rem 2rem; font-size: 1rem; cursor: pointer; border-radius: 8px; margin-top: 1rem; }
    button:hover { background: #c590d9; }
    .result { margin-top: 1rem; padding: 1rem; background: #000; border-radius: 8px; }
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
        resultDiv.innerHTML = '✓ Success! Old logs merged. <a href="/api/stats" style="color: #353726;">View Stats Dashboard</a>';
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

