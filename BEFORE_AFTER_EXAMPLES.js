// ============================================================================
// BEFORE AND AFTER COMPARISON
// This shows real examples from your code, refactored to use utils.js
// ============================================================================

// ============================================================================
// EXAMPLE 1: The /api/stats route - Average Stay Calculation
// Location: Lines 617-660 in your original code
// ============================================================================

// ─── BEFORE (CURRENT CODE) ──────────────────────────────────────────────────

function calculateAverageStayOLD() {
  // Build name->dates maps from BOOKED and RELEASED lines
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
        
        // MANUAL DATE PARSING - repeated code
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
    
    // Similar manual parsing for RELEASED lines...
  }

  // Calculate stays
  let totalStayHours = 0;
  let stayCount = 0;

  for (const [name, bookDates] of bookingsByName.entries()) {
    const relDates = releasesByName.get(name);
    if (relDates) {
      const lastBook = bookDates[bookDates.length - 1];
      const lastRelease = relDates[relDates.length - 1];

      if (lastRelease > lastBook) {
        // MANUAL TIME CALCULATION
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
  return avgStayDays;
}

// ─── AFTER (REFACTORED WITH UTILS) ──────────────────────────────────────────

import { parseBookingDate, daysBetween } from './utils.js';

function calculateAverageStayNEW() {
  // Build name->dates maps from BOOKED and RELEASED lines
  const bookingsByName = new Map();
  const releasesByName = new Map();

  // Parse bookings
  for (const line of lines) {
    if (line.startsWith('BOOKED |')) {
      const nameMatch = line.match(/BOOKED \| ([^|]+) \|/);
      const dateMatch = line.match(/Booked:\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/);
      
      if (nameMatch && dateMatch) {
        const name = nameMatch[1].trim();
        
        // USE CENTRALIZED DATE PARSER - single source of truth
        const bookDate = parseBookingDate(dateMatch[1] + ' ' + dateMatch[2]);
        
        // parseBookingDate returns null for invalid dates - handle gracefully
        if (!bookDate) continue;
        
        if (!bookingsByName.has(name)) {
          bookingsByName.set(name, []);
        }
        bookingsByName.get(name).push(bookDate);
      }
    }
    
    // Similar for RELEASED lines (now also uses parseBookingDate)...
  }

  // Calculate stays
  let totalStayDays = 0;
  let stayCount = 0;

  for (const [name, bookDates] of bookingsByName.entries()) {
    const relDates = releasesByName.get(name);
    if (relDates) {
      const lastBook = bookDates[bookDates.length - 1];
      const lastRelease = relDates[relDates.length - 1];

      if (lastRelease > lastBook) {
        // USE CENTRALIZED DAY CALCULATOR - clearer intent
        const stayDays = daysBetween(lastBook, lastRelease);

        if (stayDays > 0 && stayDays < 365) {
          totalStayDays += stayDays;
          stayCount++;
        }
      }
    }
  }

  const avgStayDays = stayCount > 0 ? Math.round(totalStayDays / stayCount) : 0;
  return avgStayDays;
}

// ─── BENEFITS ───────────────────────────────────────────────────────────────
/*
1. LESS CODE: 
   - Removed 5 lines of manual date parsing
   - Removed 2 lines of manual time calculation
   
2. MORE READABLE:
   - "parseBookingDate(dateStr)" is self-documenting
   - "daysBetween(start, end)" clearly shows intent
   
3. MORE ROBUST:
   - parseBookingDate validates dates (catches Feb 30, etc)
   - parseBookingDate returns null for invalid input
   - Timezone handling is consistent
   
4. EASIER TO MAINTAIN:
   - Bug in date parsing? Fix it once in utils.js
   - Want to change date format? Change utils.js only
   - No duplicate code means no duplicate bugs
*/

// ============================================================================
// EXAMPLE 2: Time Served Parsing in Deep Stats
// Location: Lines 807+ in your original code
// ============================================================================

// ─── BEFORE ─────────────────────────────────────────────────────────────────

function parseTimeServedOLD(history) {
  let historyTimeMinutes = [];
  
  for (const entry of history) {
    // MANUAL REGEX PARSING
    const tsMatch = (entry.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
    if (tsMatch) {
      // MANUAL CALCULATION
      const mins = parseInt(tsMatch[1]) * 1440 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
      // MANUAL VALIDATION
      if (mins > 0 && mins < 525600) {
        historyTimeMinutes.push(mins);
      }
    }
  }
  
  return historyTimeMinutes;
}

// ─── AFTER ──────────────────────────────────────────────────────────────────

import { parseTimeServed } from './utils.js';

function parseTimeServedNEW(history) {
  let historyTimeMinutes = [];
  
  for (const entry of history) {
    // ONE LINE - parseTimeServed handles regex, calculation, and validation
    const mins = parseTimeServed(entry.timeServed);
    if (mins) {
      historyTimeMinutes.push(mins);
    }
  }
  
  return historyTimeMinutes;
}

// Even better - use array methods:
function parseTimeServedBEST(history) {
  return history
    .map(entry => parseTimeServed(entry.timeServed))
    .filter(mins => mins !== null);
}

// ─── BENEFITS ───────────────────────────────────────────────────────────────
/*
Went from 10 lines to 1-3 lines while gaining:
- Better error handling (parseTimeServed logs warnings)
- Consistent validation
- More functional style (map/filter)
*/

// ============================================================================
// EXAMPLE 3: Date Formatting in /api/status
// Location: Line 369 in your original code
// ============================================================================

// ─── BEFORE ─────────────────────────────────────────────────────────────────

const statusHTML = `
  <div class="stat-value">
    ${lastCheck !== "Never" ? 
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
      : "Never"}
  </div>
`;

// ─── AFTER ──────────────────────────────────────────────────────────────────

import { formatDatePST } from './utils.js';

const statusHTML = `
  <div class="stat-value">
    ${lastCheck !== "Never" ? formatDatePST(new Date(lastCheck)) : "Never"}
  </div>
`;

// ─── BENEFITS ───────────────────────────────────────────────────────────────
/*
- 12 lines of template literal config → 1 function call
- Consistent formatting across all pages
- PST/PDT automatically handled
*/

// ============================================================================
// TESTING STRATEGY
// ============================================================================

/*
After you make these changes, here's how to verify everything works:

1. TEST DATE PARSING:
   - Run /api/run to capture roster
   - Check browser console for "Invalid date detected" warnings
   - If you see warnings, investigate those log entries

2. TEST CALCULATIONS:
   - Visit /api/stats
   - Verify "Average Length of Stay" looks reasonable
   - Check that dates display correctly with PST timezone

3. TEST DEEP STATS:
   - Visit /api/deepstats
   - Verify time served calculations (should match old page)
   - Check that bail calculations still work

4. TEST EDGE CASES:
   - Manually add a bad date to change_log.txt like:
     "BOOKED | TEST | Booked: 99/99/99 99:99:99 | Charges: Test"
   - Run /api/run
   - Should see warning in logs: "Invalid date detected: 99/99/99..."
   - Stats pages should handle this gracefully (skip invalid entry)

5. REGRESSION TEST:
   - Compare numbers before/after refactoring
   - Total bookings, releases, etc should be identical
   - If they differ, check for bugs in refactored code
*/
