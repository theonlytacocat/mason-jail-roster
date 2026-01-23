import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdf from 'pdf-parse';

const PDF_URL = 'https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf';

export default async function handler(req, res) {
  try {
    // Download PDF
    const response = await fetch(PDF_URL);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Extract text
    const data = await pdf(buffer);
    const text = data.text;
    
    // Calculate hash
    const currentHash = crypto.createHash('md5').update(text).digest('hex');
    
    // Use /tmp for serverless environment
    const dataDir = '/tmp';
    const hashFile = path.join(dataDir, 'prev_hash.txt');
    const rosterFile = path.join(dataDir, 'prev_roster.txt');
    
    let previousHash = '';
    let previousText = '';
    let hasChanged = false;
    let isFirstRun = false;
    
    // Check if we have previous data
    if (fs.existsSync(hashFile) && fs.existsSync(rosterFile)) {
      previousHash = fs.readFileSync(hashFile, 'utf-8').trim();
      previousText = fs.readFileSync(rosterFile, 'utf-8');
      hasChanged = currentHash !== previousHash;
    } else {
      isFirstRun = true;
    }
    
    // Save current state
    fs.writeFileSync(hashFile, currentHash);
    fs.writeFileSync(rosterFile, text);
    
    const timestamp = new Date().toISOString();
    
    // Parse changes if detected
    let bookings = [];
    let releases = [];
    
    if (hasChanged && !isFirstRun) {
      const currentIds = extractBookingIds(text);
      const previousIds = extractBookingIds(previousText);
      
      bookings = currentIds.filter(id => !previousIds.includes(id));
      releases = previousIds.filter(id => !currentIds.includes(id));
    }
    
    return res.status(200).json({
      success: true,
      timestamp,
      isFirstRun,
      hasChanged,
      bookings: bookings.length,
      releases: releases.length,
      mes