import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PDFParse } from 'pdf-parse';

z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject"),
  text: z.string().optional().describe("Plain text body"),
  html: z.string().optional().describe("HTML body"),
  attachments: z.array(
    z.object({
      filename: z.string().describe("File name"),
      content: z.string().describe("Base64 encoded content"),
      contentType: z.string().optional().describe("MIME type"),
      encoding: z.enum(["base64", "7bit", "quoted-printable", "binary"]).default("base64")
    })
  ).optional().describe("Email attachments")
});
async function getAuthToken() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error("REPLIT_CONNECTORS_HOSTNAME not set");
  }
  const { stdout } = await promisify(execFile)(
    "replit",
    ["identity", "create", "--audience", `https://${hostname}`],
    { encoding: "utf8" }
  );
  const replitToken = stdout.trim();
  if (!replitToken) {
    throw new Error("Replit Identity Token not found for repl/depl");
  }
  return { authToken: `Bearer ${replitToken}`, hostname };
}
async function sendEmail(message) {
  const { hostname, authToken } = await getAuthToken();
  const response = await fetch(`https://${hostname}/api/v2/mailer/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Replit-Authentication": authToken
    },
    body: JSON.stringify({
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments
    })
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Failed to send email");
  }
  return await response.json();
}

async function extractTextFromPdf(pdfPath) {
  try {
    const buffer = fs.readFileSync(pdfPath);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const info = await parser.getInfo({ parsePageInfo: true });
    await parser.destroy();
    return {
      text: result.text,
      numpages: info.total
    };
  } catch (error) {
    throw new Error(
      `Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseRosterToBookings(text) {
  const bookings = /* @__PURE__ */ new Map();
  const bookingBlocks = text.split(/(?=Booking #:)/);
  for (const block of bookingBlocks) {
    if (!block.includes("Booking #:")) continue;
    const bookingMatch = block.match(/Booking #:\s*(\S+)/);
    if (!bookingMatch) continue;
    const bookingNumber = bookingMatch[1];
    const nameMatch = block.match(/Name:\s*([A-Z][A-Z\s,'-]+?)(?=\s*Name Number:|$)/i);
    let name = nameMatch ? nameMatch[1].trim() : "Unknown";
    name = name.replace(/\s+/g, " ").trim();
    if (name.endsWith(",")) {
      const nextLineMatch = block.match(/Name:\s*[^\n]+\n([A-Z][A-Z\s'-]*)/i);
      if (nextLineMatch) {
        name = name + " " + nextLineMatch[1].trim();
      }
    }
    const bookDateMatch = block.match(/Book Date:\s*(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    let bookDate = "Unknown";
    if (bookDateMatch) {
      bookDate = bookDateMatch[2] + " " + bookDateMatch[1];
    }
    const relDateMatch = block.match(/Rel Date:\s*(No Rel Date|(\d{1,2}:\d{2}:\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))/);
    let releaseDate = "Not Released";
    if (relDateMatch) {
      if (relDateMatch[1] === "No Rel Date") {
        releaseDate = "Not Released";
      } else if (relDateMatch[2] && relDateMatch[3]) {
        releaseDate = relDateMatch[3] + " " + relDateMatch[2];
      }
    }
    const charges = [];
    const lines = block.split("\n");
    let inChargeSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes("Statute") && trimmed.includes("Offense")) {
        inChargeSection = true;
        continue;
      }
      if (inChargeSection && trimmed) {
        if (trimmed.match(/^Booking #:/) || trimmed.match(/^--\s*\d+\s*of\s*\d+\s*--/) || trimmed.match(/^Page\s+\d+/i) || trimmed.match(/^Current Inmate/i) || trimmed.match(/^rpjlciol/)) {
          break;
        }
        if (trimmed.match(/^\d+[A-Z.]+/) || trimmed.match(/^[A-Z]+\.\d+/)) {
          const offenseMatch = trimmed.match(/^\S+\s+(.+?)\s+(DIST|SUPR|MUNI)/);
          if (offenseMatch) {
            charges.push(offenseMatch[1].trim());
          }
        }
      }
    }
    const uniqueCharges = [...new Set(charges)];
    bookings.set(bookingNumber, {
      bookingNumber,
      name,
      bookDate,
      releaseDate,
      charges: uniqueCharges,
      rawText: block.substring(0, 500)
    });
  }
  return bookings;
}
function compareRosters(previousText, currentText) {
  const previousBookings = parseRosterToBookings(previousText);
  const currentBookings = parseRosterToBookings(currentText);
  const added = [];
  const removed = [];
  for (const [bookingNum, entry] of currentBookings) {
    if (!previousBookings.has(bookingNum)) {
      added.push(entry);
    }
  }
  for (const [bookingNum, entry] of previousBookings) {
    if (!currentBookings.has(bookingNum)) {
      removed.push(entry);
    }
  }
  return { added, removed };
}
function formatBookingForDisplay(entry) {
  const chargesList = entry.charges.join(", ") || "No charges listed";
  return `${entry.name} | Booked: ${entry.bookDate} | Release: ${entry.releaseDate} | Charges: ${chargesList}`;
}

const PDF_URL = "https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf";
const STORAGE_DIR = ".data";
const PREV_HASH_FILE = `${STORAGE_DIR}/prev_hash.txt`;
const PREV_ROSTER_FILE = `${STORAGE_DIR}/prev_roster.txt`;
const CHANGE_LOG_FILE = `${STORAGE_DIR}/change_log.txt`;
function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}
const downloadPdfTool = createTool({
  id: "download-pdf",
  description: "Downloads the Mason County Jail Roster PDF from the official source",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    pdfBuffer: z.string().describe("Base64 encoded PDF content"),
    error: z.string().optional()
  }),
  execute: async (ctx) => {
    const logger = ctx.mastra?.getLogger();
    logger?.info("Downloading PDF from Mason County...");
    try {
      const response = await fetch(PDF_URL);
      if (!response.ok) {
        throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64Content = buffer.toString("base64");
      logger?.info("PDF downloaded successfully", {
        size: buffer.length
      });
      return {
        success: true,
        pdfBuffer: base64Content
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("Failed to download PDF", { error: errorMessage });
      return {
        success: false,
        pdfBuffer: "",
        error: errorMessage
      };
    }
  }
});
const extractPdfTextTool = createTool({
  id: "extract-pdf-text",
  description: "Extracts all text content from a PDF buffer",
  inputSchema: z.object({
    pdfBuffer: z.string().describe("Base64 encoded PDF content")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    text: z.string(),
    error: z.string().optional()
  }),
  execute: async (ctx) => {
    const logger = ctx.mastra?.getLogger();
    logger?.info("Extracting text from PDF...");
    try {
      const buffer = Buffer.from(ctx.context.pdfBuffer, "base64");
      ensureStorageDir();
      const tempPdfPath = path.join(STORAGE_DIR, `temp_${Date.now()}.pdf`);
      fs.writeFileSync(tempPdfPath, buffer);
      logger?.info("Saved temp PDF file", { path: tempPdfPath });
      const parsed = await extractTextFromPdf(tempPdfPath);
      fs.unlinkSync(tempPdfPath);
      logger?.info("Cleaned up temp PDF file");
      const text = parsed.text;
      logger?.info("Text extracted successfully", {
        characterCount: text.length,
        pageCount: parsed.numpages
      });
      return {
        success: true,
        text
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("Failed to extract text", { error: errorMessage });
      return {
        success: false,
        text: "",
        error: errorMessage
      };
    }
  }
});
const compareRosterTool = createTool({
  id: "compare-roster",
  description: "Compares the current roster text with the previous version to detect changes at the inmate/booking level",
  inputSchema: z.object({
    currentText: z.string().describe("Current roster text content")
  }),
  outputSchema: z.object({
    hasChanged: z.boolean(),
    isFirstRun: z.boolean(),
    currentHash: z.string(),
    previousHash: z.string().optional(),
    addedBookings: z.array(z.string()),
    removedBookings: z.array(z.string()),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    timestamp: z.string()
  }),
  execute: async (ctx) => {
    const logger = ctx.mastra?.getLogger();
    logger?.info("Comparing roster with previous version (booking-level)...");
    ensureStorageDir();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const currentHash = crypto.createHash("md5").update(ctx.context.currentText).digest("hex");
    let previousHash;
    let previousText;
    try {
      previousHash = fs.existsSync(PREV_HASH_FILE) ? fs.readFileSync(PREV_HASH_FILE, "utf-8").trim() : void 0;
      previousText = fs.existsSync(PREV_ROSTER_FILE) ? fs.readFileSync(PREV_ROSTER_FILE, "utf-8") : void 0;
    } catch (error) {
      logger?.warn("Could not read previous files", { error });
    }
    if (!previousHash || !previousText) {
      logger?.info("First run - no previous data found");
      return {
        hasChanged: false,
        isFirstRun: true,
        currentHash,
        previousHash: void 0,
        addedBookings: [],
        removedBookings: [],
        addedLines: [],
        removedLines: [],
        timestamp
      };
    }
    const hasChanged = currentHash !== previousHash;
    if (!hasChanged) {
      logger?.info("No changes detected");
      return {
        hasChanged: false,
        isFirstRun: false,
        currentHash,
        previousHash,
        addedBookings: [],
        removedBookings: [],
        addedLines: [],
        removedLines: [],
        timestamp
      };
    }
    const diff = compareRosters(previousText, ctx.context.currentText);
    const addedBookings = diff.added.map((entry) => formatBookingForDisplay(entry));
    const removedBookings = diff.removed.map((entry) => formatBookingForDisplay(entry));
    logger?.info("Changes detected at booking level", {
      newBookings: addedBookings.length,
      releasedBookings: removedBookings.length
    });
    return {
      hasChanged: addedBookings.length > 0 || removedBookings.length > 0,
      isFirstRun: false,
      currentHash,
      previousHash,
      addedBookings,
      removedBookings,
      addedLines: addedBookings,
      removedLines: removedBookings,
      timestamp
    };
  }
});
const saveRosterHistoryTool = createTool({
  id: "save-roster-history",
  description: "Saves the current roster state and logs changes to the history file",
  inputSchema: z.object({
    currentText: z.string(),
    currentHash: z.string(),
    timestamp: z.string(),
    hasChanged: z.boolean(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string())
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string()
  }),
  execute: async (ctx) => {
    const logger = ctx.mastra?.getLogger();
    logger?.info("Saving roster state...");
    ensureStorageDir();
    try {
      fs.writeFileSync(PREV_HASH_FILE, ctx.context.currentHash);
      fs.writeFileSync(PREV_ROSTER_FILE, ctx.context.currentText);
      if (ctx.context.hasChanged) {
        const logEntry = `
================================================================================
Change detected at: ${ctx.context.timestamp}
================================================================================
New Bookings (${ctx.context.addedLines.length}):
${ctx.context.addedLines.map((line) => `  + ${line}`).join("\n") || "  (none)"}

Released (${ctx.context.removedLines.length}):
${ctx.context.removedLines.map((line) => `  - ${line}`).join("\n") || "  (none)"}
`;
        fs.appendFileSync(CHANGE_LOG_FILE, logEntry);
        logger?.info("Change logged to history file");
      }
      logger?.info("Roster state saved successfully");
      return {
        success: true,
        message: ctx.context.hasChanged ? "Changes saved and logged" : "State updated (no changes)"
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("Failed to save state", { error: errorMessage });
      return {
        success: false,
        message: `Failed to save: ${errorMessage}`
      };
    }
  }
});
const sendNotificationEmailTool = createTool({
  id: "send-notification-email",
  description: "Sends an email notification when roster changes are detected",
  inputSchema: z.object({
    timestamp: z.string(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    summary: z.string().describe("AI-generated summary of the changes")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string()
  }),
  execute: async (ctx) => {
    const logger = ctx.mastra?.getLogger();
    logger?.info("Preparing notification email...");
    try {
      const addedSection = ctx.context.addedLines.length > 0 ? `<h3 style="color: #dc3545; font-family: Arial, sans-serif; font-size: 10pt;">BOOKED (${ctx.context.addedLines.length}):</h3>
             <ul style="font-family: Arial, sans-serif; font-size: 8pt;">${ctx.context.addedLines.slice(0, 50).map((line) => `<li>${line}</li>`).join("")}
             ${ctx.context.addedLines.length > 50 ? `<li>...and ${ctx.context.addedLines.length - 50} more</li>` : ""}</ul>` : "";
      const removedSection = ctx.context.removedLines.length > 0 ? `<h3 style="color: #28a745; font-family: Arial, sans-serif; font-size: 10pt;">RELEASED (${ctx.context.removedLines.length}):</h3>
             <ul style="font-family: Arial, sans-serif; font-size: 8pt;">${ctx.context.removedLines.slice(0, 50).map((line) => `<li>${line}</li>`).join("")}
             ${ctx.context.removedLines.length > 50 ? `<li>...and ${ctx.context.removedLines.length - 50} more</li>` : ""}</ul>` : "";
      const htmlContent = `
        <html>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #333;">Mason County Jail Roster Update</h1>
          <p><strong>Time:</strong> ${ctx.context.timestamp}</p>
          <hr style="border: 1px solid #ddd;">
          <h2>Summary</h2>
          <p>${ctx.context.summary}</p>
          <hr style="border: 1px solid #ddd;">
          ${addedSection}
          ${removedSection}
          <hr style="border: 1px solid #ddd;">
          <p style="color: #666; font-size: 12px;">
            This is an automated notification from the Mason County Jail Roster Monitor.
            <br>View the full roster: <a href="https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf">https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf</a>
          </p>
        </body>
        </html>
      `;
      const textContent = `
Mason County Jail Roster Update
================================
Time: ${ctx.context.timestamp}

Summary:
${ctx.context.summary}

BOOKED (${ctx.context.addedLines.length}):
${ctx.context.addedLines.slice(0, 30).map((line) => `+ ${line}`).join("\n")}
${ctx.context.addedLines.length > 30 ? `...and ${ctx.context.addedLines.length - 30} more` : ""}

RELEASED (${ctx.context.removedLines.length}):
${ctx.context.removedLines.slice(0, 30).map((line) => `- ${line}`).join("\n")}
${ctx.context.removedLines.length > 30 ? `...and ${ctx.context.removedLines.length - 30} more` : ""}

View full roster: https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf
      `;
      const result = await sendEmail({
        to: process.env.NOTIFICATION_EMAIL || "admin@example.com",
        subject: `Mason County Jail Roster Updated - ${new Date(ctx.context.timestamp).toLocaleDateString()}`,
        html: htmlContent,
        text: textContent
      });
      logger?.info("Email sent successfully", {
        messageId: result.messageId,
        accepted: result.accepted
      });
      return {
        success: true,
        message: `Email sent successfully (ID: ${result.messageId})`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("Failed to send email", { error: errorMessage });
      return {
        success: false,
        message: `Failed to send email: ${errorMessage}`
      };
    }
  }
});

export { saveRosterHistoryTool as a, extractTextFromPdf as b, compareRosterTool as c, downloadPdfTool as d, extractPdfTextTool as e, sendEmail as f, sendNotificationEmailTool as s };
//# sourceMappingURL=rosterTools.mjs.map
