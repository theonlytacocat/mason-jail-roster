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
      changeCount = (content.match(/Change detected at:/g) || []).length;
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
    body { font-family: Arial, sans-serif; font-size: 8pt; background: #181818; color: #93bd8b; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 500px; padding: 2rem; }
    h1 { font-family: 'Noto Serif', sans-serif; font-size: 2rem; margin-bottom: 1.5rem; color: #b8b8b8; letter-spacing: -4px; }
    .status { background: #000; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; }
    .status-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
    .status-dot { width: 12px; height: 12px; background: #5f8a2f; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .status-title { font-weight: 600; }
    .stats { display: grid; gap: 1rem; }
    .stat { display: flex; justify-content: space-between; padding: 0.75rem 0; border-bottom: 1px solid #334155; }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #94b8b5; }
    .stat-value { font-weight: 500; }
    .run-btn { display: block; width: 100%; padding: 0.75rem; margin-top: 1rem; background: #385517; color: #fff; text-align: center; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .run-btn:hover { background: #93bd8b; }
    .footer { text-align: center; color: #4c6e60; font-size: 0.875rem; margin-top: 1.5rem; }
    a { color: #589270; text-decoration: none; }
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
          <span class="stat-label">Notifications</span>
          <span class="stat-value">Enabled</span>
        </div>
        <div class="stat">
          <span class="stat-label">Page Views</span>
          <span class="stat-value">${viewCount.toLocaleString()}</span>
        </div>
      </div>
      <a href="/api/run" class="run-btn">Run Check Now</a>
      <a href="/api/history" class="run-btn" style="margin-top: 0.75rem; background: #385517;">View Change History</a>
    </div>
    <div class="footer">
      <p><a href="/api/history">View Change History</a></p>
      <p style="margin-top: 0.5rem;">Monitoring <a href="https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf" target="_blank">Mason County Jail Roster</a></p>
      <a href="/legislative" style="display: inline-block; margin-top: 1rem; padding: 0.5rem 1rem; background: #445645; color: #ffa0f9; border-radius: 6px; text-decoration: none; font-size: 0.75rem;">Washington State Legislative Session News Update</a>
    </div>
  </div>
</body>
</html>`;

  res.send(html);
});

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
      
      // Start capturing after header
      if (t === "StatuteOffenseCourtOffenseClass") {
        inCharges = true;
        continue;
      }
      
      // Stop if we hit another booking
      if (t.startsWith("Booking #:")) {
        break;
      }
      
      // If in charges section and line has content
      if (inCharges && t.length > 0) {
        // Skip header lines and page markers
        if (t.includes("Name Number:") || t.includes("Book Date:") || 
            t.includes("Rel Date:") || t.includes("Page ") || 
            t.includes("rpjlciol") || t.includes("Current Inmate") ||
            t.includes("StatuteOffenseCourtOffenseClass")) {
          continue;
        }
        
        // Match pattern: StatuteCode + OffenseName + CourtType + OffenseType + Class
        // Example: 9.41.040.1.AWeapons OffenseSUPRWOFFFB
        const chargeMatch = t.match(/^[\d\w.()]+([A-Z][A-Za-z\s,.-]+?)(DIST|SUPR|MUNI|DOC)/);
        
        if (chargeMatch) {
          const offense = chargeMatch[1].trim();
          if (offense && offense.length > 1) {
            charges.push(offense);
          }
        }
      }
    }

    bookings.set(id, {
      id,
      name,
      bookDate,
      releaseDate,
      charges: [...new Set(charges)]  // Remove duplicates
    });
  }
  return bookings;
}

    function formatBooked(b) {
      return b.name + " | Booked: " + b.bookDate + " | Charges: " + (b.charges.join(", ") || "None listed");
    }

    function formatReleased(b, stats, isPending = false) {
      const releaseInfo = stats.get(b.name);
      if (releaseInfo) {
        const bailAmount = parseFloat(releaseInfo.bail.replace(/[$,]/g, ''));
        const bailText = bailAmount > 0 ? " | Bail Posted: " + releaseInfo.bail : "";
        
        return {
          text: b.name + " | Released: " + releaseInfo.releaseDateTime + 
                " | Time served: " + releaseInfo.timeServed + 
                bailText +
                " (" + releaseInfo.releaseType + ")" +
                " | Charges: " + (b.charges.join(", ") || "None listed"),
          hasPendingDetails: false
        };
      }
      
      // No release stats available yet
      if (isPending) {
        return {
          text: b.name + " | Released: " + b.releaseDate + " (exact time pending)" + 
                " | Charges: " + (b.charges.join(", ") || "None listed"),
          hasPendingDetails: true,
          bookingData: b
        };
      }
      
      return {
        text: b.name + " | Released: " + b.releaseDate + " | Charges: " + (b.charges.join(", ") || "None listed"),
        hasPendingDetails: false
      };
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
    const logEntry =
      "\n================================================================================\n" +
      (isFirstRun ? "Initial capture" : hasChanged ? "Change detected" : "No change") +
      " at: " + timestamp +
      "\n================================================================================\n" +
      (isFirstRun ? "Initial roster state captured.\n" :
       hasChanged ?
         "BOOKED (" + addedLines.length + "):\n" +
         addedLines.map(l => "  + " + l).join("\n") +
         "\n\nRELEASED (" + removedLines.length + "):\n" +
         removedLines.map(l => "  - " + l).join("\n") + "\n"
         : "No changes detected.\n");

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
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/api/status"><style>body{font-family:sans-serif;background:#181818;color:#93bd8b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.success{color:#5f8a2f;font-size:3rem;margin-bottom:1rem;}h1{color:#b8b8b8;margin-bottom:1rem;}p{color:#94b8b5;}</style></head><body><div class="container"><div class="success">✓</div><h1>Workflow Complete</h1><p>' +
      message +
      "</p><p>Redirecting to status page...</p></div></body></html>";

    res.send(html);
  } catch (error) {
    console.error('Error in /api/run:', error);
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#181818;color:#93bd8b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.error{color:#ef4444;font-size:3rem;margin-bottom:1rem;}h1{color:#ef4444;margin-bottom:1rem;}p{color:#94a3b8;}a{color:#38bdf8;}</style></head><body><div class="container"><div class="error">✗</div><h1>Error</h1><p>' +
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
    body { font-family: Arial, sans-serif; font-size: 9pt; background: #181818; color: #93bd8b; min-height: 100vh; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-family: 'Noto Serif', sans-serif; font-size: 2rem; margin-bottom: 0.5rem; color: #b8b8b8; letter-spacing: -4px; }
    .subtitle { color: #4c6e60; margin-bottom: 2rem; }
    .back-link { display: inline-block; margin-bottom: 1.5rem; color: #589270; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .content { background: #000; border-radius: 12px; padding: 2rem; margin-bottom: 1rem; line-height: 1.6; }
    .content h2 { color: #ffa0f9; margin-top: 1.5rem; margin-bottom: 0.75rem; font-size: 1.2rem; }
    .content h2:first-child { margin-top: 0; }
    .content h3 { color: #93bd8b; margin-top: 1rem; margin-bottom: 0.5rem; font-size: 1rem; }
    .content p { margin-bottom: 0.75rem; color: #94b8b5; }
    .content ul { margin-left: 1.5rem; margin-bottom: 1rem; }
    .content li { margin-bottom: 0.5rem; color: #94b8b5; }
    .update-date { color: #ffa0f9; font-weight: bold; margin-bottom: 1rem; }
    a { color: #589270; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/status" class="back-link">← Back to Jail Roster Monitor</a>
    <h1>Washington State Legislative Session</h1>
    <p class="subtitle">2026 Session Updates and Bill Tracking</p>
    
    <div class="content">
      <p class="update-date">Updates: 1/29/2026</p>
      
      <h2>Washington state legislature 2026 - what's actually going on</h2>

      <h2>POLICE & PUBLIC SAFETY:</h2>
      <p>BAN ON POLICE FACE COVERINGS - Would prohibit cops from wearing masks/balaclavas while interacting with public. Sparked by ice raids. Lots of momentum.</p>
      <p>$100 MILLION POLICE HIRING GRANTS (SB.5060) - Covers 75% of new officer salaries for 36 months. Ferguson's priority. Cities must implement 0.1% sales tax or already have a similar tax to have access to funds.</p>
      <p>SHERIFF/POLICE CHIEF REQUIREMENTS (HB.1399/SB.5974) - New standards: minimum age would be 25, background checks to be performed, must maintain peace officer certification. Sheriffs union is PISSED, calling it unconstitutional.</p>
      <p>PUBLIC DEFENSE CRISIS (SB.5404) - Making the state actually fund public defenders. WA is one of only 2 states that doesn't fully fund them, leading to overworked defenders and constitutional violations.</p>
      <p>FLOCK LICENSE PLATE CAMERA REGULATION - New bill would regulate automated license plate readers across the state.</p>
      <p>NO SECRET POLICE ACT - Requiring law enforcement to be identifiable during arrests.</p>

      <h2>GUN CONTROL:</h2>
      <p>PERMIT TO PURCHASE (HB.1163) - Requiring state permit before buying firearms, like a dozen other states have.</p>
      <p>EXPANDING GUN-FREE ZONES and setting BULK PURCHASE LIMITS.</p>
      <p>REQUIRING GUN STORAGE IN CARS/HOMES, as well as more REGULATIONS FOR GUN DEALERS.</p>

      <h2>EDUCATION:</h2>
      <p>PARENTAL RIGHTS INITIATIVES - Two super controversial initiatives coming that would give parents access to ALL school curriculum, allow parents to see mental health counseling records from school counselors. Often called a rewrite of last year's controversial HB.1296.</p>

      <h2>TAXES AND BUDGETS:</h2>
      <p>MILLIONAIRE INCOME TAX- Nearly 10% tax on people making over $1 million/year, would raise $3 billion annually. super controversial since WA has never had an income tax and it might violate the state constitution. republicans threatening lawsuits.</p>
      <p>PAYROLL TAX ON HIGH EARNERS (HB.2100) - 5% tax on employers for employees making over $125k/year to fund "well Washington fund" for healthcare/education/human services.</p>
      <p>HIGHER EDUCATION FUNDING RESET - 10% tuition cuts for 3 years starting fall 2027, expanding Washington college grant eligibility.</p>
      <p>PAID PROTESTER TAX - Would tax temporary staffing agencies that provide "paid protesters" at protests.</p>
      <p>BULLION TAX REPEAL (HB.2093) - Republicans trying to eliminate the sales tax on gold/silver, saying it's driving coin shops out of business.</p>
      <p>REVERSING 2025 TAX INCREASES (HB.2101) - Rolling back recent tax hikes to keep investment local.</p>

      <h2>ARTIFICIAL INTELLIGENCE- there are so many of them:</h2>
      <p>AI COMPANION CHATBOTS (SB.5984/HB.2225) - Regulating AI chatbots for minors after child suicides linked to AI. Prohibits romantic partnerships with minors, requires hourly notifications that it's not human. private right of action included. Tech industry is pushing back heavily on this.</p>
      <p>AI IN SCHOOLS (HB.2481/SB.5956) - Requiring human oversight of AI systems in schools, addressing surveillance, risk scoring, and automated discipline of students. Protecting kids from being flagged by gun detection AI that mistakes chips bags for weapons.</p>
      <p>REGULATIONS FOR AI: Use in therapy, specifically mental health treatment.</p>
      <p>HEALTH INSURANCE: Regulating AI insurance authorization decisions for medical procedures.</p>
      <p>TRAINING DATA TRANSPARENCY - Requiring disclosure of what data is used to train AI models.</p>
      <p>COLLECTIVE BARGAINING AROUND AI - Allowing unions to negotiate how AI is used in workplaces.</p>
      <p>GROCERY STORE AI SURVEILLANCE - Regulating facial recognition and surge pricing based on AI.</p>

      <h2>WILDFIRE & ENVIRONMENT:</h2>
      <p>WILDFIRE PREVENTION FUNDING: Fighting $60 million cut to wildfire resilience budget. $125 million per biennium for forest health.</p>
      <p>CLEAN ENERGY GRID EXPANSION, as well as a SEMI TRUCK EMISSIONS CLIMATE PUSH.</p>

      <h2>HOUSING & DEVELOPMENT:</h2>
      <p>COMMERCIAL TO RESIDENTIAL CONVERSION (SB.6026) - Governor's priority - allowing mixed-use and residential in commercial zones without rezoning. Abandoned strip malls and big-box stores could become housing.</p>
      <p>SHORT-TERM RENTAL TAX (SB.5576) - Up to 4% excise tax on Airbnbs to fund affordable housing. Was statewide, amended to let local governments decide.</p>
      <p>PARKING REFORM - Already passed in 2025, now implementing rules reducing parking requirements that drive up housing costs.</p>

      <h2>IMMIGRATION AND LABOR:</h2>
      <p>IMMIGRANT WORKER PROTECTIONS (HB.2105/SB.5852) - Requiring employers to give workers notice if ice does an i-9 audit of legal work status.</p>
      <p>MINIMUM WAGE $17.13/HOUR - Already in effect Jan 1, 2026. Highest in the nation. Some cities higher (Seattle $21.63, Seatac $20.74).</p>
      <p>STRIKING WORKERS GET UNEMPLOYMENT - Already in effect. strikers can collect up to 6 weeks of unemployment benefits after strike starts.</p>
      <p>PAID FAMILY LEAVE EXPANSION - Job protection after only 180 days (down from 12 months). Minimum leave reduced to 4 hours (from 8 hours).</p>
      <p>WORKPLACE VIOLENCE PREVENTION - Healthcare facilities must investigate violence incidents promptly and update prevention plans annually</p>
      <p>ISOLATED WORKER PROTECTIONS - Panic buttons and safety measures for janitors, housekeepers, security guards who work alone.</p>

      <h2>HEALTHCARE & VACCINES:</h2>
      <p>STATE VACCINE AUTHORITY (SB.5967/HB.2242) - Governor's priority. Allowing WA dept of health to make vaccine recommendations independent of cdc/federal government. Response to trump politicizing CDC, does NOT create new mandates.</p>

      <h2>ALREADY IN EFFECT:</h2>
      <p>MEDICAL DEBT CREDIT REPORTING BAN - Medical debt can't be reported to credit agencies.</p>
      <p>BLOOD TYPE ON DRIVER'S LICENSE (SB.5689) - Voluntary blood type info on state IDS.</p>

      <h2>TRANSPORTATION & ROADS:</h2>
      <p>RECKLESS DRIVING REDEFINED (SB.5890) - 30+ mph over speed limit = reckless driving charge.</p>
      <p>RECKLESS INTERFERENCE WITH EMERGENCY OPERATIONS (HB.2203) - New driving offense for blocking emergency vehicles.</p>

      <h2>CRIMINAL JUSTICE:</h2>
      <p>POLITICAL AFFILIATION HATE CRIME (SB.5830) - Making it a Class C felony to assault someone based on their political beliefs.</p>
      <p>JUVENILE DETENTION OVERCROWDING - Allowing youth transfers to state prisons and community facilities in certain cases.</p>
      <p>EARLY RELEASE FOR YOUTH OFFENDERS - Allowing people convicted before age 18 to petition for early release at age 24.</p>
      <p>DUI LAB EXPANSION - Allowing more labs to perform toxicology tests to speed up cases.</p>

      <h2>CONSUMER & BUSINESS ALREADY IN EFFECT:</h2>
      <p>NICOTINE/VAPE TAX - 95% excise tax on ALL nicotine products including synthetic nicotine, vapes, pouches. A $7 product now costs $15.06 after taxes.</p>
      <p>PLASTIC BAG FEE INCREASE - Minimum charge raised from 8 cents to 12 cents per bag.</p>

      <h2>RANDOMS:</h2>
      <p>DIAPER CHANGING STATIONS - Already in effect. Mandatory in all new/remodeled public buildings costing $15k+.</p>
      <p>GRAY WOLF RECLASSIFICATION - Downgrading from "endangered" to "sensitive" status.</p>
      <p>DISCOVER PASS PRICE HIKE - Increasing from $30 to $45 for state parks access, would be the first increase in 14 years.</p>

      <p style="margin-top: 2rem; color: #4c6e60; font-style: italic;">For more information, visit <a href="https://leg.wa.gov" target="_blank">leg.wa.gov</a></p>
    </div>
  </div>
</body>
</html>`;
  
  res.send(html);
});

// History page
app.get('/api/history', (req, res) => {
  const dataDir = STORAGE_DIR;
  let changeLog = "";
  let entries = [];

  try {
    const logFile = path.join(dataDir, "change_log.txt");
    if (fs.existsSync(logFile)) {
      changeLog = fs.readFileSync(logFile, "utf-8");

      const sections = changeLog.split("================================================================================").filter(s => s.trim());
      for (let i = 0; i < sections.length; i += 2) {
        const header = sections[i] || "";
        const content = sections[i + 1] || "";

        const timestampMatch = header.match(/(?:Change detected at|Initial capture at|No change at|Release details update at): (.+)/);
        if (timestampMatch) {
          const addedMatch = content.match(/(?:BOOKED|New Bookings|Added lines) \((\d+)\):\n([\s\S]*?)(?=\n(?:RELEASED|Releases|Removed lines|UPDATED)|$)/);
          const removedMatch = content.match(/(?:RELEASED|Releases|Removed lines) \((\d+)\):\n([\s\S]*?)(?=\n(?:UPDATED)|$)/);
          const updatedMatch = content.match(/(?:UPDATED RELEASE INFORMATION) \((\d+)\):\n([\s\S]*?)$/);

          const added = addedMatch ? addedMatch[2].split("\n").filter(l => l.trim().startsWith("+")).map(l => l.replace(/^\s*\+\s*/, "")) : [];
          const removed = removedMatch ? removedMatch[2].split("\n").filter(l => l.trim().startsWith("-")).map(l => l.replace(/^\s*-\s*/, "")) : [];
          const updated = updatedMatch ? updatedMatch[2].split("\n").filter(l => l.trim().startsWith("✓")).map(l => l.replace(/^\s*✓\s*/, "")) : [];

          entries.push({
            timestamp: timestampMatch[1].trim(),
            added,
            removed,
            updated
          });
        }
      }
    }
  } catch (e) {}

  entries.reverse();

  // Group consecutive "Initial roster capture" / "No change" entries
  const groupedEntries = [];
  let noChangeGroup = [];
  
  for (const entry of entries) {
    const hasChanges = entry.added.length > 0 || entry.removed.length > 0 || (entry.updated && entry.updated.length > 0);
    
    if (!hasChanges) {
      // This is a "no change" entry - add to group
      noChangeGroup.push(entry);
    } else {
      // This entry has changes - flush any pending no-change group first
      if (noChangeGroup.length > 0) {
        groupedEntries.push({
          type: 'no-change-group',
          count: noChangeGroup.length,
          startTime: noChangeGroup[0].timestamp,
          endTime: noChangeGroup[noChangeGroup.length - 1].timestamp
        });
        noChangeGroup = [];
      }
      // Then add the actual change entry
      groupedEntries.push(entry);
    }
  }
  
  // Don't forget any remaining no-change group at the end
  if (noChangeGroup.length > 0) {
    groupedEntries.push({
      type: 'no-change-group',
      count: noChangeGroup.length,
      startTime: noChangeGroup[0].timestamp,
      endTime: noChangeGroup[noChangeGroup.length - 1].timestamp
    });
  }

  const entriesHtml = groupedEntries.length > 0 ? groupedEntries.map(entry => {
    // Handle grouped "no change" entries
    if (entry.type === 'no-change-group') {
      const startDate = new Date(entry.startTime);
      const endDate = new Date(entry.endTime);
      const startPst = startDate.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "numeric",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      });
      const endPst = endDate.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "numeric",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      });
      
      return '<div class="entry no-change-entry"><p class="no-changes">Checked ' + entry.count + ' time' + (entry.count > 1 ? 's' : '') + ' between ' + startPst + ' - ' + endPst + ' PST (no changes detected)</p></div>';
    }
    
    // Handle regular entries with changes
    const date = new Date(entry.timestamp);
    const pstDate = date.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }) + " PST";
    
    const addedItems = entry.added.slice(0, 50).map(a => "<li>" + a + "</li>").join("");
    const addedMore = entry.added.length > 50 ? "<li>...and " + (entry.added.length - 50) + " more</li>" : "";
    const addedHtml = entry.added.length > 0 ? '<div class="changes booked"><h4>BOOKED (' + entry.added.length + ")</h4><ul>" + addedItems + addedMore + "</ul></div>" : "";

    const removedItems = entry.removed.slice(0, 50).map(r => "<li>" + r + "</li>").join("");
    const removedMore = entry.removed.length > 50 ? "<li>...and " + (entry.removed.length - 50) + " more</li>" : "";
    const removedHtml = entry.removed.length > 0 ? '<div class="changes released"><h4>RELEASED (' + entry.removed.length + ")</h4><ul>" + removedItems + removedMore + "</ul></div>" : "";

    const updatedItems = entry.updated ? entry.updated.slice(0, 50).map(u => "<li>" + u + "</li>").join("") : "";
    const updatedMore = entry.updated && entry.updated.length > 50 ? "<li>...and " + (entry.updated.length - 50) + " more</li>" : "";
    const updatedHtml = entry.updated && entry.updated.length > 0 ? '<div class="changes updated"><h4>UPDATED RELEASE INFO (' + entry.updated.length + ")</h4><ul>" + updatedItems + updatedMore + "</ul></div>" : "";

    const noChanges = !addedHtml && !removedHtml && !updatedHtml ? "<p class='no-changes'>Initial roster capture</p>" : "";

    return '<div class="entry"><div class="entry-header">' + pstDate + "</div>" + addedHtml + removedHtml + updatedHtml + noChanges + "</div>";
  }).join("") : "<p class='no-data'>No changes recorded yet. Run the workflow to start monitoring.</p>";

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
    body { font-family: Arial, sans-serif; font-size: 8pt; background: #181818; color: #93bd8b; min-height: 100vh; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-family: 'Noto Serif', sans-serif; font-size: 2rem; margin-bottom: 0.5rem; color: #b8b8b8; letter-spacing: -4px; }
    .subtitle { color: #4c6e60; margin-bottom: 2rem; }
    .back-link { display: inline-block; margin-bottom: 1.5rem; color: #589270; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .entry { background: #000; border-radius: 12px; padding: 1rem; margin-bottom: 1rem; }
    .entry.no-change-entry { background: #0a0a0a; padding: 0.75rem; border-left: 3px solid #334155; }
    .entry-header { font-weight: 600; font-size: 10pt; margin-bottom: 0.75rem; color: #93bd8b; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; }
    .changes { margin-top: 0.75rem; }
    .changes h4 { font-size: 9pt; margin-bottom: 0.4rem; font-weight: bold; }
    .changes.booked h4 { color: #701e77; }
    .changes.released h4 { color: #3e7400; }
    .changes.updated h4 { color: #589270; }
    .changes ul { list-style: none; font-size: 8pt; color: #94b8b5; }
    .changes ul li { padding: 0.2rem 0; border-bottom: 1px solid #334155; }
    .changes ul li:last-child { border-bottom: none; }
    .no-changes { color: #4c6e60; font-style: italic; }
    .no-data { color: #4c6e60; text-align: center; padding: 3rem; }
    a { color: #589270; }
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit: http://localhost:${PORT}`);
});

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