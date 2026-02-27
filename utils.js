/**
 * Utilities for Mason County Jail Roster Monitor
 * Centralized date parsing, validation, and formatting functions
 */

/**
 * Parse a booking/release date string from the jail roster PDF
 * @param {string} dateStr - Format: "MM/DD/YY HH:MM:SS" (e.g., "01/18/26 14:30:00")
 * @returns {Date|null} - Parsed Date object, or null if invalid
 * 
 * WHY: Date parsing was scattered throughout the code in 5+ places.
 * Having one function means:
 * - Bugs only need to be fixed once
 * - Timezone handling is consistent
 * - Easy to add validation
 */
function parseBookingDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }

  // Match format: "MM/DD/YY HH:MM:SS"
  const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  
  if (!match) {
    return null;
  }

  const [, month, day, year, hours, minutes, seconds] = match;
  
  // Convert 2-digit year to 4-digit (assumes 2000s)
  const fullYear = 2000 + parseInt(year);
  
  // Create date object (months are 0-indexed in JavaScript)
  const date = new Date(
    fullYear, 
    parseInt(month) - 1, 
    parseInt(day),
    parseInt(hours), 
    parseInt(minutes), 
    parseInt(seconds)
  );

  // Validation: Date should be reasonable (between 2020 and 2035)
  // This catches garbage data like "99/99/99 99:99:99"
  if (date.getFullYear() < 2020 || date.getFullYear() > 2035) {
    console.warn(`Invalid date detected: ${dateStr} parsed to ${date.toISOString()}`);
    return null;
  }

  // Validation: Check for invalid dates (like February 30th)
  // If the date object's month doesn't match what we set, it rolled over
  if (date.getMonth() !== parseInt(month) - 1) {
    console.warn(`Invalid date detected (date rollover): ${dateStr}`);
    return null;
  }

  return date;
}

/**
 * Format minutes into human-readable duration
 * @param {number} mins - Total minutes
 * @returns {string} - Formatted string like "2d 5h 30m" or "45m"
 * 
 * WHY: Used in multiple places for displaying time served.
 * Centralizing ensures consistent formatting across stats pages.
 */
function formatMinutes(mins) {
  if (!mins || mins <= 0) {
    return '—';
  }

  // Less than 1 hour - show just minutes
  if (mins < 60) {
    return `${mins}m`;
  }

  // Less than 1 day - show hours and minutes
  if (mins < 1440) {
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hours}h ${remainingMins}m`;
  }

  // 1 day or more - show days, hours, and minutes
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remainingMins = mins % 60;

  if (hours > 0) {
    return `${days}d ${hours}h ${remainingMins}m`;
  } else {
    return `${days}d ${remainingMins}m`;
  }
}

/**
 * Parse time served string from release stats PDF
 * @param {string} timeServedStr - Format: "2d 5h 30m" (with or without spaces)
 * @returns {number|null} - Total minutes, or null if invalid
 * 
 * WHY: Release stats PDF gives time served as "XdYhZm".
 * Need to convert this to minutes for calculations.
 */
function parseTimeServed(timeServedStr) {
  if (!timeServedStr || typeof timeServedStr !== 'string') {
    return null;
  }

  // Match format: "2d5h30m" or "2d 5h 30m"
  const match = timeServedStr.match(/(\d+)\s*d\s*(\d+)\s*h\s*(\d+)\s*m/);
  
  if (!match) {
    return null;
  }

  const [, days, hours, mins] = match;
  const totalMinutes = parseInt(days) * 1440 + parseInt(hours) * 60 + parseInt(mins);

  // Sanity check: Should be positive and less than 1 year (525,600 minutes)
  if (totalMinutes <= 0 || totalMinutes > 525600) {
    console.warn(`Invalid time served: ${timeServedStr} = ${totalMinutes} minutes`);
    return null;
  }

  return totalMinutes;
}

/**
 * Calculate difference between two dates in days
 * @param {Date} startDate - Earlier date
 * @param {Date} endDate - Later date
 * @returns {number} - Number of days (fractional)
 */
function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) {
    return 0;
  }

  const diffMs = endDate - startDate;
  return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * Check if a date string represents a midnight time (likely unknown time)
 * @param {string} dateStr - Format: "MM/DD/YY HH:MM:SS"
 * @returns {boolean} - True if time is 00:00:00
 * 
 * WHY: Release times of 00:00:00 often mean "time unknown".
 * These should be excluded from hourly analysis.
 */
function isMidnight(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return false;
  }

  return dateStr.includes('00:00:00');
}

/**
 * Format a Date object to PST/PDT string
 * @param {Date} date - Date object to format
 * @returns {string} - Formatted string like "2/27/2026, 2:30:45 PM PST"
 */
function formatDatePST(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return 'Never';
  }

  return date.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }) + ' PST';
}

// Export all functions
export {
  parseBookingDate,
  formatMinutes,
  parseTimeServed,
  daysBetween,
  isMidnight,
  formatDatePST
};
