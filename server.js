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

        const nameMatch = block.match(/Name:\s*([A-Z][A-Z\s,'-]+?)(?=\s*Name Number:|$)/i);
        let name = nameMatch ? nameMatch[1].trim().replace(/\s+/g, " ") : "Unknown";
        if (name.endsWith(",")) {
          const nextLine = block.match(/Name:\s*[^\n]+\n([A-Z][A-Z\s'-]*)/i);
          if (nextLine) name = name + " " + nextLine[1].trim();
        }

        const bookDateMatch = block.match(/Book Date:\s*(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        const bookDate = bookDateMatch ? bookDateMatch[2] + " " + bookDateMatch[1] : "Unknown";

        const relDateMatch = block.match(/Rel Date:\s*(No Rel Date|(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))/);
        let releaseDate = "Not Released";
        if (relDateMatch && relDateMatch[1] !== "No Rel Date" && relDateMatch[2] && relDateMatch[3]) {
          releaseDate = relDateMatch[3] + " " + relDateMatch[2];
        }

        const charges = [];
        const lines = block.split("\n");
        let inCharges = false;
        
        for (const line of lines) {
          const t = line.trim();
          
          // Start capturing after we see the header
          if (t.includes("Statute") && t.includes("Offense") && t.includes("Court")) {
            inCharges = true;
            continue;
          }
          
          // Stop if we hit another booking
          if (t.startsWith("Booking #:")) {
            break;
          }
          
          // If we're in the charges section
          if (inCharges && t.length > 0) {
            // Skip headers and other non-charge lines
            if (t.includes("Name Number:") || t.includes("Book Date:") || t.includes("Rel Date:") || 
                t.includes("Page ") || t.includes("rpjlciol") || t.includes("Current Inmate")) {
              continue;
            }
            
            // Format is: STATUTEOffenseDESCRIPTIONCOURT_TYPEOFFENSE_CODECLASS
            // Example: "72.09.310Failure to AppearSUPRFTAFC"
            // We need to extract the offense description between statute and court type
            
            // Match statute code at start, then capture until we hit DIST|SUPR|MUNI|DOC
            const match = t.match(/^[\d\w.()]+([A-Za-z\s,'-]+?)(DIST|SUPR|MUNI|DOC)[A-Z]+[A-Z]{2}$/);
            
            if (match) {
              const offense = match[1].trim();
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
          charges: [...new Set(charges)]
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

      <h2>TAXES & BUDGET (The Big Money Fights)</h2>
      <h3>Millionaire's Income Tax</h3>
      <p>Nearly 10% tax on people making over $1 million/year, would raise $3 billion annually. Super controversial since WA has never had an income tax and it might violate the state constitution. Republicans threatening lawsuits.</p>
      
      <h3>Payroll Tax on High Earners (HB 2100)</h3>
      <p>5% tax on employers for employees making over $125k/year to fund "Well Washington Fund" for healthcare/education/human services.</p>
      
      <h3>Advanced Computing Surcharge Cap Removal</h3>
      <p>Would eliminate the $75 million annual cap on big tech companies (Microsoft, Amazon) to fund higher education. Currently capped at $75M per company.</p>
      
      <h3>Higher Education Funding Reset</h3>
      <p>10% tuition cuts for 3 years starting fall 2027, expanding Washington College Grant eligibility.</p>
      
      <h3>Paid Protester Tax</h3>
      <p>Would tax temporary staffing agencies that provide "paid protesters" at protests (yes, really).</p>
      
      <h3>Bullion Tax Repeal (HB 2093)</h3>
      <p>Republicans trying to eliminate the sales tax on gold/silver, saying it's driving coin shops out of business.</p>
      
      <h3>Reversing 2025 Tax Increases (HB 2101)</h3>
      <p>Rolling back recent tax hikes to keep investment local.</p>

      <h2>ARTIFICIAL INTELLIGENCE (14+ Bills)</h2>
      <h3>AI Companion Chatbots (SB 5984/HB 2225)</h3>
      <p>Regulating AI chatbots for minors after child suicides linked to AI. Prohibits romantic partnerships with minors, requires hourly notifications that it's not human. Private right of action included (tech industry trying to remove this).</p>
      
      <h3>AI in Schools (HB 2481/SB 5956)</h3>
      <p>Requiring human oversight of AI systems in schools, addressing surveillance, risk scoring, and automated discipline of students. Protecting kids from being flagged by gun detection AI that mistakes chips bags for weapons.</p>
      
      <h3>Other AI Bills</h3>
      <ul>
        <li>AI in Therapy - Regulating AI use in mental health treatment</li>
        <li>AI in Health Insurance - Regulating AI authorization decisions for medical procedures</li>
        <li>AI Training Data Transparency - Requiring disclosure of what data is used to train AI models</li>
        <li>Collective Bargaining Around AI - Allowing unions to negotiate how AI is used in workplaces</li>
        <li>High-Risk AI Systems - Regulating AI making impactful decisions in housing, employment, healthcare</li>
        <li>Grocery Store AI Surveillance (HB 2481) - Regulating facial recognition and surge pricing based on AI</li>
      </ul>

      <h2>HOUSING & DEVELOPMENT</h2>
      <h3>Remove Local Barriers (HB 2266/SB 6069)</h3>
      <p>Streamlining development of supportive/transitional/emergency housing by removing local regulatory barriers.</p>
      
      <h3>Scissor Stairs (HB 2228)</h3>
      <p>Legalizing scissor stairwells in apartment buildings (common in Vancouver BC) to fit more units by wasting less space on hallways.</p>
      
      <h3>Elevator Reform</h3>
      <p>Adopting smaller European elevator standards to make building cheaper and faster.</p>
      
      <h3>Commercial to Residential Conversion (SB 6026)</h3>
      <p>Governor's priority - allowing mixed-use and residential in commercial zones without rezoning. Abandoned strip malls and big-box stores could become housing.</p>
      
      <h3>Short-Term Rental Tax (SB 5576)</h3>
      <p>Up to 4% excise tax on Airbnbs to fund affordable housing. Was statewide, amended to let local governments decide.</p>
      
      <h3>Parking Reform</h3>
      <p>Already passed in 2025, now implementing rules reducing parking requirements that drive up housing costs.</p>

      <h2>POLICE & PUBLIC SAFETY</h2>
      <h3>Ban on Police Face Coverings</h3>
      <p>Gaining major momentum. Would prohibit cops from wearing masks/balaclavas while interacting with public. Sparked by ICE raids where masked agents arrested people.</p>
      
      <h3>$100 Million Police Hiring Grants (SB 5060)</h3>
      <p>Covers 75% of new officer salaries for 36 months. Ferguson's priority. Cities must implement 0.1% sales tax or already have similar tax to access funds.</p>
      
      <h3>Sheriff/Police Chief Requirements (HB 1399/SB 5974)</h3>
      <p>New standards: min age 25, background checks, must maintain peace officer certification. Sheriffs PISSED, calling it unconstitutional.</p>
      
      <h3>Public Defense Crisis (SB 5404)</h3>
      <p>Making state actually fund public defenders. WA is one of only 2 states that doesn't fully fund them, leading to overworked defenders and constitutional violations.</p>
      
      <h3>Other Safety Bills</h3>
      <ul>
        <li>Flock License Plate Camera Regulation - New bill would regulate automated license plate readers across the state</li>
        <li>No Secret Police Act - Requiring law enforcement to be identifiable during arrests</li>
      </ul>

      <h2>GUN CONTROL</h2>
      <ul>
        <li>Permit to Purchase (HB 1163) - Requiring state permit before buying firearms, like a dozen other states have</li>
        <li>Expanding Gun-Free Zones - Adding more locations where carrying firearms is illegal</li>
        <li>Bulk Ammo Purchase Limits - Restricting how much ammunition can be bought at once</li>
        <li>Mandatory Gun Storage in Cars/Homes - Requiring guns be locked up</li>
        <li>Additional Gun Dealer Requirements - More regulations for firearm retailers</li>
      </ul>

      <h2>EDUCATION & PARENTAL RIGHTS</h2>
      <h3>Parental Rights Initiatives</h3>
      <p>Two super controversial initiatives coming that would:</p>
      <ul>
        <li>Give parents access to ALL school curriculum</li>
        <li>Allow parents to see mental health counseling records from school counselors</li>
        <li>One is being called a rewrite of last year's controversial HB 1296</li>
      </ul>
      
      <h3>Special Education Funding Cap Removal</h3>
      <p>Eliminating the 16% enrollment cap on special ed funding.</p>
      
      <h3>Eid State Holidays</h3>
      <p>WA is first state to recognize Eid al-Fitr and Eid al-Adha as state holidays.</p>

      <h2>IMMIGRATION</h2>
      <h3>Immigrant Worker Protections (HB 2105/SB 5852)</h3>
      <p>Requiring employers to give workers notice if ICE does an I-9 audit of legal work status.</p>

      <h2>LABOR & WORKERS</h2>
      <h3>Minimum Wage $17.13/hour</h3>
      <p>Already in effect Jan 1, 2026. Highest in the nation. Some cities higher (Seattle $21.63, SeaTac $20.74).</p>
      
      <h3>Striking Workers Get Unemployment</h3>
      <p>Already in effect. Strikers can collect up to 6 weeks of unemployment benefits after strike starts.</p>
      
      <h3>Paid Family Leave Expansion</h3>
      <p>Job protection after just 180 days (down from 12 months). Minimum leave reduced to 4 hours (from 8 hours).</p>
      
      <h3>Other Worker Protections</h3>
      <ul>
        <li>Workplace Violence Prevention - Healthcare facilities must investigate violence incidents promptly and update prevention plans annually</li>
        <li>Isolated Worker Protections - Panic buttons and safety measures for janitors, housekeepers, security guards who work alone</li>
        <li>Hate Crime Victim Leave - Time off for victims to seek safety, medical care, counseling</li>
      </ul>

      <h2>HEALTHCARE & VACCINES</h2>
      <h3>State Vaccine Authority (SB 5967/HB 2242)</h3>
      <p>Governor's priority. Allowing WA Dept of Health to make vaccine recommendations independent of CDC/federal government. Response to Trump politicizing CDC. Does NOT create new mandates.</p>
      
      <h3>Already in Effect</h3>
      <ul>
        <li>Medical Debt Credit Reporting Ban - Medical debt can't be reported to credit agencies</li>
        <li>Blood Type on Driver's License (SB 5689) - Voluntary blood type info on state IDs</li>
      </ul>
      
      <h3>Other Healthcare Bills</h3>
      <ul>
        <li>Physician Assistant Compact - Joining interstate agreement for PA licensing</li>
        <li>Mental Health Parity - Strengthening enforcement of mental health coverage requirements</li>
      </ul>

      <h2>ENVIRONMENT & ENERGY</h2>
      <h3>Nuclear Power Strategic Framework</h3>
      <p>Bipartisan push to embrace nuclear energy development. Department of Commerce to publish framework for opportunities/obstacles. No state funding - must use private money.</p>
      
      <h3>Wildfire Prevention Funding</h3>
      <p>Fighting $60 million cut to wildfire resilience budget. $125 million per biennium for forest health.</p>
      
      <h3>Other Environmental Initiatives</h3>
      <ul>
        <li>Clean Energy Grid Expansion - Accelerating transmission and renewable energy to meet climate goals while lowering bills</li>
        <li>Big Truck Climate Push - New regulations targeting commercial vehicle emissions</li>
      </ul>

      <h2>TRANSPORTATION & ROADS</h2>
      <h3>Reckless Driving Redefined (SB 5890)</h3>
      <p>30+ mph over speed limit = reckless driving charge.</p>
      
      <h3>Reckless Interference with Emergency Operations (HB 2203)</h3>
      <p>New driving offense for blocking emergency vehicles.</p>
      
      <h3>Ferry System Crisis</h3>
      <p>7 of 21 ferries currently unable to sail due to mechanical issues and planned maintenance.</p>

      <h2>CRIMINAL JUSTICE & CRIME</h2>
      <ul>
        <li>Political Affiliation Hate Crime (SB 5830) - Making it a Class C felony to assault someone based on their political beliefs</li>
        <li>Juvenile Detention Overcrowding - Allowing youth transfers to state prisons and community facilities in certain cases</li>
        <li>Early Release for Youth Offenders - Allowing people convicted before age 18 to petition for early release at age 24</li>
        <li>DUI Lab Expansion - Allowing more labs to perform toxicology tests to speed up cases</li>
      </ul>

      <h2>CONSUMER & BUSINESS</h2>
      <h3>Already in Effect</h3>
      <ul>
        <li>Nicotine/Vape Tax - 95% excise tax on ALL nicotine products including synthetic nicotine, vapes, pouches. A $7 product now costs $15.06 after taxes</li>
        <li>Plastic Bag Fee Increase - Minimum charge raised from 8 cents to 12 cents per bag</li>
      </ul>
      
      <h3>Pending Bills</h3>
      <ul>
        <li>Right to Repair (HB 1483) - Electronics manufacturers must provide parts and repair methods to independent shops</li>
        <li>Luxury Vehicle Tax - New taxes on high-end cars</li>
        <li>Permitting and Licensing Improvements - Governor's priority to streamline business permits</li>
      </ul>

      <h2>WEIRD/QUIRKY ONES</h2>
      <ul>
        <li>Diaper Changing Stations - Already in effect. Mandatory in all new/remodeled public buildings costing $15k+</li>
        <li>Gray Wolf Reclassification - Downgrading from "endangered" to "sensitive" status</li>
        <li>Discover Pass Price Hike - Increasing from $30 to $45 for state parks access. First increase in 14 years</li>
        <li>Cannabis License Changes - Various updates to marijuana business regulations</li>
        <li>Pesticide Committee Extension - Extending Pesticide Application Safety Committee to 2035</li>
      </ul>

      <h2>INITIATIVE PROCESS REFORM</h2>
      <h3>Revamping Initiatives</h3>
      <p>Democrats want to change how citizen initiatives work. Getting MASSIVE pushback from Republicans and initiative supporters who see it as Democrats trying to make it harder to challenge the legislature.</p>

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

  const entriesHtml = entries.length > 0 ? entries.map(entry => {
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