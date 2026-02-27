/**
 * Tests for utils.js
 * Run with: node test-utils.js
 */

import {
  parseBookingDate,
  formatMinutes,
  parseTimeServed,
  daysBetween,
  isMidnight,
  formatDatePST
} from './utils.js';

console.log('Testing parseBookingDate...\n');

// Test valid dates
console.log('✓ Valid date:', parseBookingDate('01/18/26 14:30:00'));
console.log('✓ Valid date:', parseBookingDate('12/31/25 23:59:59'));
console.log('✓ Single digit month/day:', parseBookingDate('1/5/26 9:15:30'));

// Test invalid dates
console.log('✗ Invalid date (garbage):', parseBookingDate('99/99/99 99:99:99'));
console.log('✗ Invalid date (Feb 30):', parseBookingDate('02/30/26 12:00:00'));
console.log('✗ Invalid date (null):', parseBookingDate(null));
console.log('✗ Invalid date (empty string):', parseBookingDate(''));

console.log('\n---\nTesting formatMinutes...\n');

console.log('✓ 30 minutes:', formatMinutes(30));
console.log('✓ 90 minutes:', formatMinutes(90));
console.log('✓ 1500 minutes (1d 1h):', formatMinutes(1500));
console.log('✓ 4320 minutes (3d):', formatMinutes(4320));
console.log('✓ 0 minutes:', formatMinutes(0));
console.log('✓ negative:', formatMinutes(-5));

console.log('\n---\nTesting parseTimeServed...\n');

console.log('✓ "2d 5h 30m":', parseTimeServed('2d 5h 30m'));
console.log('✓ "2d5h30m" (no spaces):', parseTimeServed('2d5h30m'));
console.log('✓ "0d 0h 15m":', parseTimeServed('0d 0h 15m'));
console.log('✗ Invalid format:', parseTimeServed('2 days 5 hours'));
console.log('✗ Null:', parseTimeServed(null));

console.log('\n---\nTesting daysBetween...\n');

const date1 = new Date('2026-01-01');
const date2 = new Date('2026-01-08');
console.log('✓ Jan 1 to Jan 8:', daysBetween(date1, date2), 'days');

const date3 = parseBookingDate('01/18/26 14:00:00');
const date4 = parseBookingDate('01/20/26 14:00:00');
console.log('✓ 2 days difference:', daysBetween(date3, date4), 'days');

console.log('\n---\nTesting isMidnight...\n');

console.log('✓ Is midnight:', isMidnight('02/09/26 00:00:00'));
console.log('✗ Not midnight:', isMidnight('02/09/26 14:30:00'));
console.log('✗ Invalid:', isMidnight(null));

console.log('\n---\nTesting formatDatePST...\n');

console.log('✓ Current date:', formatDatePST(new Date()));
console.log('✓ Specific date:', formatDatePST(parseBookingDate('01/18/26 14:30:00')));
console.log('✗ Invalid date:', formatDatePST(null));

console.log('\n✅ All tests complete!');
