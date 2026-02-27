/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║                    UTILS.JS QUICK REFERENCE                            ║
 * ║                  Keep this open while refactoring                      ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 */

import {
  parseBookingDate,
  formatMinutes,
  parseTimeServed,
  daysBetween,
  isMidnight,
  formatDatePST
} from './utils.js';

// ────────────────────────────────────────────────────────────────────────────
// parseBookingDate(dateStr)
// ────────────────────────────────────────────────────────────────────────────
// INPUT:  String in format "MM/DD/YY HH:MM:SS" (e.g., "01/18/26 14:30:00")
// OUTPUT: Date object, or null if invalid
// USE:    Anywhere you see manual date parsing with split('/') and new Date()

// OLD CODE (DON'T DO THIS):
const [month, day, year] = dateStr.split('/');
const [hours, minutes, seconds] = timeStr.split(':');
const date = new Date(2000 + parseInt(year), parseInt(month) - 1, ...);

// NEW CODE (DO THIS):
const date = parseBookingDate('01/18/26 14:30:00');
if (!date) {
  console.log('Invalid date, skipping...');
  continue;
}

// VALIDATES:
// ✓ Catches impossible dates (02/30/26, 99/99/99)
// ✓ Returns null for garbage input
// ✓ Logs warnings for debugging
// ✓ Handles single-digit months/days (1/5/26)

// ────────────────────────────────────────────────────────────────────────────
// formatMinutes(mins)
// ────────────────────────────────────────────────────────────────────────────
// INPUT:  Number of minutes
// OUTPUT: Human-readable string like "2d 5h 30m" or "45m"
// USE:    Displaying time served, length of stay

// EXAMPLES:
formatMinutes(30)    // → "30m"
formatMinutes(90)    // → "1h 30m"
formatMinutes(1500)  // → "1d 1h 0m"
formatMinutes(0)     // → "—"
formatMinutes(-5)    // → "—"

// OLD CODE (DON'T DO THIS):
function fmtMins(mins) {
  if (!mins || mins <= 0) return '—';
  if (mins < 60) return `${mins}m`;
  // ... lots more logic
}

// NEW CODE (DO THIS):
const displayTime = formatMinutes(totalMinutes);

// ────────────────────────────────────────────────────────────────────────────
// parseTimeServed(timeStr)
// ────────────────────────────────────────────────────────────────────────────
// INPUT:  String in format "2d 5h 30m" or "2d5h30m" (with or without spaces)
// OUTPUT: Total minutes as number, or null if invalid
// USE:    Parsing time served from release stats PDF

// EXAMPLES:
parseTimeServed('2d 5h 30m')  // → 3210 minutes
parseTimeServed('2d5h30m')    // → 3210 minutes
parseTimeServed('0d 0h 15m')  // → 15 minutes
parseTimeServed('garbage')    // → null

// OLD CODE (DON'T DO THIS):
const tsMatch = timeStr.match(/(\d+)d(\d+)h(\d+)m/);
if (tsMatch) {
  const mins = parseInt(tsMatch[1]) * 1440 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
  if (mins > 0 && mins < 525600) {
    // use mins
  }
}

// NEW CODE (DO THIS):
const mins = parseTimeServed(entry.timeServed);
if (mins) {
  historyTimeMinutes.push(mins);
}

// VALIDATES:
// ✓ Checks for negative values
// ✓ Rejects times over 1 year (likely errors)
// ✓ Logs warnings for debugging
// ✓ Handles with/without spaces

// ────────────────────────────────────────────────────────────────────────────
// daysBetween(startDate, endDate)
// ────────────────────────────────────────────────────────────────────────────
// INPUT:  Two Date objects
// OUTPUT: Number of days (can be fractional like 2.5)
// USE:    Calculating length of stay, time between events

// EXAMPLES:
const bookDate = parseBookingDate('01/01/26 12:00:00');
const releaseDate = parseBookingDate('01/08/26 12:00:00');
daysBetween(bookDate, releaseDate)  // → 7

// OLD CODE (DON'T DO THIS):
const stayMs = endDate - startDate;
const stayHours = stayMs / (1000 * 60 * 60);
const stayDays = stayHours / 24;

// NEW CODE (DO THIS):
const stayDays = daysBetween(bookDate, releaseDate);
if (stayDays > 0 && stayDays < 365) {
  totalStayDays += stayDays;
}

// ────────────────────────────────────────────────────────────────────────────
// isMidnight(dateStr)
// ────────────────────────────────────────────────────────────────────────────
// INPUT:  Date string in format "MM/DD/YY HH:MM:SS"
// OUTPUT: true if time is 00:00:00, false otherwise
// USE:    Detecting unknown release times (often show as midnight)

// EXAMPLES:
isMidnight('02/09/26 00:00:00')  // → true
isMidnight('02/09/26 14:30:00')  // → false

// USE CASE:
if (!isMidnight(entry.releaseDateTime)) {
  // Only count in hourly statistics if we have real time
  const hour = parseInt(entry.releaseDateTime.split(' ')[1].split(':')[0]);
  releaseHours[hour]++;
}

// ────────────────────────────────────────────────────────────────────────────
// formatDatePST(date)
// ────────────────────────────────────────────────────────────────────────────
// INPUT:  Date object
// OUTPUT: Formatted string like "2/27/2026, 2:30:45 PM PST"
// USE:    Displaying dates in UI with consistent timezone

// EXAMPLES:
formatDatePST(new Date())  // → "2/27/2026, 1:15:30 PM PST"
formatDatePST(null)        // → "Never"

// OLD CODE (DON'T DO THIS):
new Date(lastCheck).toLocaleString("en-US", { 
  timeZone: "America/Los_Angeles", 
  year: "numeric", 
  month: "numeric", 
  day: "numeric", 
  hour: "numeric", 
  minute: "2-digit", 
  second: "2-digit", 
  hour12: true 
}) + " PST"

// NEW CODE (DO THIS):
const displayDate = formatDatePST(new Date(lastCheck));

// ────────────────────────────────────────────────────────────────────────────
// COMMON PATTERNS
// ────────────────────────────────────────────────────────────────────────────

// PATTERN 1: Parsing booking/release dates from log lines
const dateMatch = line.match(/(?:Booked|Released):\s+(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/);
if (dateMatch) {
  const date = parseBookingDate(dateMatch[1]);
  if (date) {
    // Use date
  }
}

// PATTERN 2: Calculating stay duration
const bookDate = parseBookingDate(booking.bookDate);
const releaseDate = parseBookingDate(release.releaseDate);
if (bookDate && releaseDate && releaseDate > bookDate) {
  const stayDays = daysBetween(bookDate, releaseDate);
  console.log(`Stayed ${stayDays} days`);
}

// PATTERN 3: Processing time served from release stats
const mins = parseTimeServed(entry.timeServed);
if (mins) {
  const hours = Math.round(mins / 60);
  const display = formatMinutes(mins);
  console.log(`Served ${display} (${hours} hours)`);
}

// PATTERN 4: Filtering out midnight (unknown) times
const validReleases = releases.filter(r => !isMidnight(r.releaseDateTime));

// PATTERN 5: Display dates consistently
const lastCheckDisplay = lastCheck !== 'Never' 
  ? formatDatePST(new Date(lastCheck)) 
  : 'Never';

// ────────────────────────────────────────────────────────────────────────────
// ERROR HANDLING
// ────────────────────────────────────────────────────────────────────────────

// All functions return null/0/"—" for invalid input
// ALWAYS check return values before using:

// ✓ GOOD:
const date = parseBookingDate(dateStr);
if (date) {
  // Use date
}

// ✗ BAD:
const date = parseBookingDate(dateStr);
const days = daysBetween(date, new Date()); // Error if date is null!

// ────────────────────────────────────────────────────────────────────────────
// DEBUGGING
// ────────────────────────────────────────────────────────────────────────────

// Functions log warnings to console for invalid input:
// - "Invalid date detected: 99/99/99 parsed to ..."
// - "Invalid time served: 999d 99h 99m = ... minutes"

// To see these warnings:
// - Check server logs (console where you run node)
// - Look for patterns of invalid data
// - Fix data quality issues at the source

// ────────────────────────────────────────────────────────────────────────────
// MIGRATION CHECKLIST
// ────────────────────────────────────────────────────────────────────────────

/*
□ Import utils.js at top of file
□ Replace manual date parsing → parseBookingDate()
□ Replace manual time calculations → daysBetween()
□ Replace fmtMins() → formatMinutes()
□ Replace manual time served parsing → parseTimeServed()
□ Replace toLocaleString configs → formatDatePST()
□ Add null checks after parseBookingDate()
□ Test all pages
□ Verify numbers match old code
□ Check console for warnings
□ Deploy!
*/
