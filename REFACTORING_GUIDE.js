/**
 * REFACTORING GUIDE: How to Update Your Server to Use utils.js
 * 
 * Follow these steps in order. Each step shows you:
 * 1. WHERE in your code to make the change (line numbers are approximate)
 * 2. WHAT to change (the old code)
 * 3. WHY we're changing it
 * 4. The NEW code to use
 */

// ============================================================================
// STEP 1: Add the import at the top of your file (around line 7)
// ============================================================================

// OLD CODE (line 1-7):
/*
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import PDFParser from 'pdf-parse';
*/

// NEW CODE - Add this import:
/*
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
*/

// ============================================================================
// STEP 2: Replace extractDateFromLine function (around line 289)
// ============================================================================

// OLD CODE - This whole function can be DELETED:
/*
function extractDateFromLine(line) {
  const match = line.match(/Booked:\s+(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (match) {
    const [dateStr, timeStr] = match[1].split(' ');
    const [month, day, year] = dateStr.split('/');
    const [hours, minutes, seconds] = timeStr.split(':');
    const fullYear = 2000 + parseInt(year);
    return new Date(fullYear, parseInt(month) - 1, parseInt(day), 
                   parseInt(hours), parseInt(minutes), parseInt(seconds));
  }
  // ... more parsing code ...
  return new Date();
}
*/

// NEW CODE - Replace the entire function with this simple version:
/*
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
*/

// WHY: Now uses our centralized parseBookingDate which handles validation,
// timezone consistency, and error handling all in one place.

// ============================================================================
// STEP 3: Update the average stay calculation (around line 617)
// ============================================================================

// OLD CODE - Manual date parsing in loop:
/*
for (const [name, bookDates] of bookingsByName.entries()) {
  const relDates = releasesByName.get(name);
  if (relDates) {
    const lastBook = bookDates[bookDates.length - 1];
    const lastRelease = relDates[relDates.length - 1];

    if (lastRelease > lastBook) {
      const stayMs = lastRelease - lastBook;
      const stayHours = stayMs / (1000 * 60 * 60);
      // ... more code
    }
  }
}
*/

// NEW CODE - Use daysBetween:
/*
for (const [name, bookDates] of bookingsByName.entries()) {
  const relDates = releasesByName.get(name);
  if (relDates) {
    const lastBook = bookDates[bookDates.length - 1];
    const lastRelease = relDates[relDates.length - 1];

    if (lastRelease > lastBook) {
      const stayDays = daysBetween(lastBook, lastRelease);
      
      if (stayDays > 0 && stayDays < 365) { // Between 0 and 365 days
        totalStayHours += stayDays * 24;
        stayCount++;
      }
    }
  }
}
*/

// WHY: daysBetween is clearer and handles the math correctly

// ============================================================================
// STEP 4: Update /api/status date formatting (around line 369)
// ============================================================================

// OLD CODE - Manual toLocaleString:
/*
${lastCheck !== "Never" ? new Date(lastCheck).toLocaleString("en-US", { 
  timeZone: "America/Los_Angeles", 
  year: "numeric", 
  month: "numeric", 
  day: "numeric", 
  hour: "numeric", 
  minute: "2-digit", 
  second: "2-digit", 
  hour12: true 
}) + " PST" : "Never"}
*/

// NEW CODE - Use formatDatePST:
/*
${lastCheck !== "Never" ? formatDatePST(new Date(lastCheck)) : "Never"}
*/

// WHY: Much cleaner and ensures consistent timezone formatting everywhere

// ============================================================================
// STEP 5: Replace the fmtMins function in deep stats (around line 1012)
// ============================================================================

// OLD CODE - The entire fmtMins function:
/*
function fmtMins(mins) {
  if (!mins || mins <= 0) return '—';
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins/60)}h ${mins%60}m`;
  const d = Math.floor(mins/1440);
  const h = Math.floor((mins%1440)/60);
  const m = mins%60;
  return h > 0 ? `${d}d ${h}h ${m}m` : `${d}d ${m}m`;
}
*/

// NEW CODE - Just use formatMinutes from utils:
// DELETE the fmtMins function entirely, then find/replace all instances:
// - Find: fmtMins(
// - Replace: formatMinutes(

// WHY: Same functionality, but now shared across all pages

// ============================================================================
// STEP 6: Fix time served parsing in release stats history (around line 807)
// ============================================================================

// OLD CODE - Manual regex for time served:
/*
const tsMatch = (entry.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
if (tsMatch) {
  const mins = parseInt(tsMatch[1]) * 1440 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
  if (mins > 0 && mins < 525600) historyTimeMinutes.push(mins);
}
*/

// NEW CODE - Use parseTimeServed:
/*
const mins = parseTimeServed(entry.timeServed);
if (mins) {
  historyTimeMinutes.push(mins);
}
*/

// WHY: parseTimeServed already validates the range, making code cleaner

// ============================================================================
// STEP 7: Update longest current inmate calculation (around line 753)
// ============================================================================

// OLD CODE - Manual date parsing:
/*
const parts = booking.bookDate.split(' ');
if (parts.length === 2) {
  const [datePart, timePart] = parts;
  const [bm, bd, by] = datePart.split('/');
  const [bh, bmin, bs] = timePart.split(':');
  const byr = by.length === 2 ? 2000 + parseInt(by) : parseInt(by);
  const bookDate = new Date(byr, parseInt(bm)-1, parseInt(bd), 
                           parseInt(bh), parseInt(bmin), parseInt(bs));
  const daysIn = (nowStats - bookDate) / (1000 * 60 * 60 * 24);
  // ... more code
}
*/

// NEW CODE - Use parseBookingDate and daysBetween:
/*
const bookDate = parseBookingDate(booking.bookDate);
if (bookDate) {
  const daysIn = daysBetween(bookDate, nowStats);
  if (daysIn > longestDays) {
    longestDays = daysIn;
    longestInmate = { 
      name: booking.name, 
      days: Math.floor(daysIn), 
      bookDate: booking.bookDate 
    };
  }
}
*/

// WHY: Much cleaner, and parseBookingDate will return null for invalid dates

// ============================================================================
// SUMMARY: What You Get After These Changes
// ============================================================================

/*
BEFORE:
- Date parsing code duplicated in 5+ places
- Inconsistent error handling
- Hard to maintain
- No validation for impossible dates

AFTER:
- One source of truth for date parsing
- Consistent validation everywhere
- Easy to fix bugs (change one function)
- Clearer, more readable code
- Automatic detection of invalid dates (like 00:00:00 times)

TESTING:
After making these changes, test by:
1. Visit /api/run to capture current roster
2. Visit /api/stats to verify dates display correctly
3. Visit /api/deepstats to verify time calculations
4. Check browser console for any "Invalid date detected" warnings
*/
