import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PDF_URL = 'https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf';
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Serve static files from public
app.use(express.static('public'));

// Extract booking IDs from roster text
function extractBookingIds(text) {
  const matches = [...text.matchAll(/Booking #:\s*(\S+)/g)];
  return matches.map(m => m[1]);
}

// Extract detailed booking info
function extractBookings(rosterText) {
  const bookings = new Map();
  const blocks = rosterText.split(/(?=Booking #:)/);
  
  for (const block of blocks) {
    if (!block.includes('Booking #:')) continue;
    
    const bookingMatch = block.match(/Booking #:\s*(\S+)/);
    if (!bookingMatch) continue;
    const id = bookingMatch[1];
    
    const nameMatch = block.match(/Name:\s*([A-Z][A-Z\s,'-]+?)(?=\s*Name Number:|$)/i);
    let name = nameMatch ? nameMatch[1].trim().replace(/\s+/g, ' ') : 'Unknown';
    
    const bookDateMatch = block.match(/Book Date:\s*(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const bookDate = bookDateMatch ? bookDateMatch[2] + ' ' + bookDateMatch[1] : 'Unknown';
    
    const relDateMatch = block.match(/Rel Date:\s*(No Rel Date|(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))/);
    let releaseDate = 'Not Released';
    if (relDateMatch && relDateMatch[1] !== 'No Rel Date' && relDateMatch[2] && relDateMatch[3]) {
      releaseDate = relDateMatch[3] + ' ' + relDateMatch[2];
    }
    
    const charges = [];
    const lines = block.split('\n');
    let inCharges = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.includes('Statute') && t.includes('Offense')) {
        inCharges = true;
        continue;
      }
      if (inCharges && t && !t.match(/^Booking #:|^--|^Page|^Current|^rpjlciol/)) {
        const m = t.match(/^\S+\s+(.+?)\s+(DIST|SUPR|MUNI)/);
        if (m) charges.push(m[1].trim());
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

function formatBooked(b) {
  return b.name + ' | Booked: ' + b.bookDate + ' | Charges: ' + (b.charges.join(', ') || 'None listed');
}

function formatReleased(b) {
  return b.name + ' | Released: ' + b.releaseDate + ' | Charges: ' + (b.charges.join(', ') || 'None listed');
}

// Status endpoint
app.get('/api/status', (req, res) => {
  let lastCheck = 'Never';
  let inmateCount = 0;
  let changeCount = 0;
  let viewCount = 0;
  
  try {
    const hashFile = path.join(DATA_DIR, 'prev_hash.txt');
    if (fs.existsSync(hashFile)) {
      const stats = fs.statSync(hashFile);
      lastCheck = stats.mtime.toISOString();
    }
    
    const rosterFile = path.join(DATA_DIR, 'prev_roster.txt');
    if (fs.existsSync(rosterFile)) {
      const content = fs.readFileSync(rosterFile, 'utf-8');
      const bookingMatches = content.match(/Booking #:/g);
      inmateCount = bookingMatches ? bookingMatches.length : 0;
    }
    
    const logFile = path.join(DATA_DIR, 'change_log.txt');
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      changeCount = (content.match(/Change detected at:/g) || []).length;
    }
    
    const metricsFile = path.join(DATA_DIR, 'metrics.json');
    let metrics = { statusViews: 0, historyViews: 0 };
    
    if (fs.existsSync(metricsFile)) {
      try {
        metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf-8'));
      } catch (e) {}
    }
    metrics.statusViews = (metrics.statusViews || 0) + 1;
    viewCount = metrics.statusViews;
    
    try {
      fs.writeFileSync(metricsFile, JSON.stringify(metrics));
    } catch (e) {
      console.error('Failed to write metrics:', e);
    }
  } catch (e) {
    console.error('Status error:', e);
  }
  
  res.json({
    lastCheck,
    inmateCount,
    changeCount,
    viewCount,
    status: 'active'
  });
});

// Check roster endpoint
app.get('/api/check-roster', async (req, res) => {
  try {
    console.log('Downloading PDF...');
    const response = await fetch(PDF_URL);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // For now, use buffer as text representation
    // In production, you'd use a proper PDF parser
    const text = buffer.toString('binary');
    
    const currentHash = crypto.createHash('md5').update(text).digest('hex');
    const timestamp = new Date().toISOString();
    
    const hashFile = path.join(DATA_DIR, 'prev_hash.txt');
    const rosterFile = path.join(DATA_DIR, 'prev_roster.txt');
    const logFile = path.join(DATA_DIR, 'change_log.txt');
    
    let previousHash = '';
    let previousText = '';
    let hasChanged = false;
    let isFirstRun = false;
    let addedLines = [];
    let removedLines = [];
    
    if (fs.existsSync(hashFile) && fs.existsSync(rosterFile)) {
      previousHash = fs.readFileSync(hashFile, 'utf-8').trim();
      previousText = fs.readFileSync(rosterFile, 'utf-8');
      hasChanged = currentHash !== previousHash;
      
      if (hasChanged) {
        const currentBookings = extractBookings(text);
        const previousBookings = extractBookings(previousText);
        
        for (const [id, booking] of currentBookings) {
          if (!previousBookings.has(id)) {
            addedLines.push(formatBooked(booking));
          }
        }
        for (const [id, booking] of previousBookings) {
          if (!currentBookings.has(id)) {
            removedLines.push(formatReleased(booking));
          }
        }
        addedLines = addedLines.slice(0, 30);
        removedLines = removedLines.slice(0, 30);
      }
    } else {
      isFirstRun = true;
    }
    
    fs.writeFileSync(hashFile, currentHash);
    fs.writeFileSync(rosterFile, text);
    
    const logEntry = '\n' + '='.repeat(80) + '\n' +
      (isFirstRun ? 'Initial capture' : hasChanged ? 'Change detected' : 'No change') +
      ' at: ' + timestamp + '\n' + '='.repeat(80) + '\n' +
      (isFirstRun ? 'Initial roster state captured.\n' :
       hasChanged ? 
         'BOOKED (' + addedLines.length + '):\n' +
         addedLines.map(l => '  + ' + l).join('\n') + '\n\n' +
         'RELEASED (' + removedLines.length + '):\n' +
         removedLines.map(l => '  - ' + l).join('\n') + '\n'
         : 'No changes detected.\n');
    
    fs.appendFileSync(logFile, logEntry);
    
    const message = isFirstRun ? 'Initial roster captured successfully!' :
      hasChanged ? 'Changes detected! ' + addedLines.length + ' new bookings, ' + removedLines.length + ' releases.' :
      'No changes detected.';
    
    res.json({
      success: true,
      timestamp,
      isFirstRun,
      hasChanged,
      bookings: addedLines.length,
      releases: removedLines.length,
      message
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// History endpoint
app.get('/api/history', (req, res) => {
  const logFile = path.join(DATA_DIR, 'change_log.txt');
  let changeLog = '';
  let entries = [];
  
  try {
    if (fs.existsSync(logFile)) {
      changeLog = fs.readFileSync(logFile, 'utf-8');
      
      const sections = changeLog.split('='.repeat(80)).filter(s => s.trim());
      for (let i = 0; i < sections.length; i += 2) {
        const header = sections[i] || '';
        const content = sections[i + 1] || '';
        
        const timestampMatch = header.match(/(?:Change detected at|Initial capture at|No change at): (.+)/);
        if (timestampMatch) {
          const addedMatch = content.match(/BOOKED \((\d+)\):\n([\s\S]*?)(?=\nRELEASED|$)/);
          const removedMatch = content.match(/RELEASED \((\d+)\):\n([\s\S]*?)$/);
          
          const added = addedMatch ? addedMatch[2].split('\n').filter(l => l.trim().startsWith('+')).map(l => l.replace(/^\s*\+\s*/, '')) : [];
          const removed = removedMatch ? removedMatch[2].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^\s*-\s*/, '')) : [];
          
          entries.push({
            timestamp: timestampMatch[1].trim(),
            added,
            removed
          });
        }
      }
    }
  } catch (e) {
    console.error('History error:', e);
  }
  
  entries.reverse();
  
  const entriesHtml = entries.length > 0 ?
    entries.map(entry => {
      const date = new Date(entry.timestamp);
      const pstDate = date.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      }) + ' PST';
      
      const addedHtml = entry.added.length > 0 ?
        '<div class="changes booked"><h4>BOOKED (' + entry.added.length + ')</h4><ul>' +
        entry.added.slice(0, 50).map(a => '<li>' + a + '</li>').join('') +
        (entry.added.length > 50 ? '<li>...and ' + (entry.added.length - 50) + ' more</li>' : '') +
        '</ul></div>' : '';
      
      const removedHtml = entry.removed.length > 0 ?
        '<div class="changes released"><h4>RELEASED (' + entry.removed.length + ')</h4><ul>' +
        entry.removed.slice(0, 50).map(r => '<li>' + r + '</li>').join('') +
        (entry.removed.length > 50 ? '<li>...and ' + (entry.removed.length - 50) + ' more</li>' : '') +
        '</ul></div>' : '';
      
      const noChanges = !addedHtml && !removedHtml ? '<p class="no-changes">Initial roster capture</p>' : '';
      
      return '<div class="entry"><div class="entry-header">' + pstDate + '</div>' + addedHtml + removedHtml + noChanges + '</div>';
    }).join('') :
    '<p class="no-data">No changes recorded yet. Run the workflow to start monitoring.</p>';
  
  const html = `<!DOCTYPE html><html><head><title>Change History</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: Arial, sans-serif; font-size: 8pt; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 2rem; } .container { max-width: 900px; margin: 0 auto; } h1 { font-size: 14pt; margin-bottom: 0.5rem; color: #38bdf8; } .subtitle { color: #64748b; margin-bottom: 2rem; } .back-link { display: inline-block; margin-bottom: 1.5rem; color: #38bdf8; text-decoration: none; } .back-link:hover { text-decoration: underline; } .entry { background: #1e293b; border-radius: 12px; padding: 1rem; margin-bottom: 1rem; } .entry-header { font-weight: 600; font-size: 10pt; margin-bottom: 0.75rem; color: #f8fafc; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; } .changes { margin-top: 0.75rem; } .changes h4 { font-size: 9pt; margin-bottom: 0.4rem; font-weight: bold; } .changes.booked h4 { color: #ef4444; } .changes.released h4 { color: #22c55e; } .changes ul { list-style: none; font-size: 8pt; color: #94a3b8; } .changes ul li { padding: 0.2rem 0; border-bottom: 1px solid #334155; } .changes ul li:last-child { border-bottom: none; } .no-changes { color: #64748b; font-style: italic; } .no-data { color: #64748b; text-align: center; padding: 3rem; } a { color: #38bdf8; }</style></head><body><div class="container"><a href="/" class="back-link">← Back to Status</a><h1>Change History</h1><p class="subtitle">Record of all detected changes in the jail roster (newest first)</p>${entriesHtml}</div></body></html>`;
  
  res.send(html);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});