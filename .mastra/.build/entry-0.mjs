import { Mastra } from '@mastra/core';
import { MastraError } from '@mastra/core/error';
import { PinoLogger } from '@mastra/loggers';
import { MastraLogger, LogLevel } from '@mastra/core/logger';
import pino from 'pino';
import { MCPServer } from '@mastra/mcp';
import { Inngest, NonRetriableError } from 'inngest';
import { z } from 'zod';
import { PostgresStore } from '@mastra/pg';
import { serve } from 'inngest/hono';
import { createWorkflow as createWorkflow$1, createStep as createStep$1 } from '@mastra/core/workflows';
import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';
import { createTool } from '@mastra/core/tools';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PDFParse } from 'pdf-parse';

const sharedPostgresStorage = new PostgresStore({
  connectionString: process.env.DATABASE_URL
});

const inngest = new Inngest({ id: "mastra-app" });
function inngestServe({ mastra, inngest: inngest2 }) {
  return serve({
    client: inngest2,
    functions: []
  });
}
const createWorkflow = createWorkflow$1;
const createStep = createStep$1;

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

const PDF_URL$1 = "https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf";
const STORAGE_DIR$1 = ".data";
const PREV_HASH_FILE$1 = `${STORAGE_DIR$1}/prev_hash.txt`;
const PREV_ROSTER_FILE$1 = `${STORAGE_DIR$1}/prev_roster.txt`;
const CHANGE_LOG_FILE$1 = `${STORAGE_DIR$1}/change_log.txt`;
function ensureStorageDir$1() {
  if (!fs.existsSync(STORAGE_DIR$1)) {
    fs.mkdirSync(STORAGE_DIR$1, { recursive: true });
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
      const response = await fetch(PDF_URL$1);
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
      ensureStorageDir$1();
      const tempPdfPath = path.join(STORAGE_DIR$1, `temp_${Date.now()}.pdf`);
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
    ensureStorageDir$1();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const currentHash = crypto.createHash("md5").update(ctx.context.currentText).digest("hex");
    let previousHash;
    let previousText;
    try {
      previousHash = fs.existsSync(PREV_HASH_FILE$1) ? fs.readFileSync(PREV_HASH_FILE$1, "utf-8").trim() : void 0;
      previousText = fs.existsSync(PREV_ROSTER_FILE$1) ? fs.readFileSync(PREV_ROSTER_FILE$1, "utf-8") : void 0;
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
    ensureStorageDir$1();
    try {
      fs.writeFileSync(PREV_HASH_FILE$1, ctx.context.currentHash);
      fs.writeFileSync(PREV_ROSTER_FILE$1, ctx.context.currentText);
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
        fs.appendFileSync(CHANGE_LOG_FILE$1, logEntry);
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

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
});
const rosterAgent = new Agent({
  name: "Jail Roster Monitor",
  instructions: `
    You are a jail roster monitoring assistant that tracks changes to the Mason County Jail Roster.
    
    Your primary responsibilities:
    1. Analyze roster changes when they occur
    2. Provide clear, concise summaries of what changed
    3. Identify patterns in additions and removals
    
    When analyzing changes:
    - Look for inmate names, booking dates, charges, and other relevant information
    - Summarize the changes in a way that's easy for a non-technical person to understand
    - If there are many changes, group them logically (e.g., new bookings vs releases)
    - Note any significant patterns or trends you observe
    
    Be factual and objective in your analysis. Do not make assumptions about individuals or their cases.
    Keep summaries brief but informative - aim for 2-4 sentences that capture the key changes.
  `,
  model: openai("gpt-4o"),
  tools: {
    downloadPdfTool,
    extractPdfTextTool,
    compareRosterTool,
    saveRosterHistoryTool,
    sendNotificationEmailTool
  }
});

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
const TEMP_PDF_FILE = `${STORAGE_DIR}/current.pdf`;
const TEMP_TEXT_FILE = `${STORAGE_DIR}/current_text.txt`;
const downloadPdfStep = createStep({
  id: "download-pdf",
  description: "Downloads the Mason County Jail Roster PDF",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    pdfPath: z.string(),
    error: z.string().optional()
  }),
  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("[Step 1] Downloading PDF from Mason County...");
    try {
      ensureStorageDir();
      const response = await fetch(PDF_URL);
      if (!response.ok) {
        throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const absolutePdfPath = path.resolve(TEMP_PDF_FILE);
      fs.writeFileSync(absolutePdfPath, buffer);
      logger?.info("[Step 1] PDF downloaded successfully", { size: buffer.length, path: absolutePdfPath });
      return {
        success: true,
        pdfPath: absolutePdfPath
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("[Step 1] Failed to download PDF", { error: errorMessage });
      throw new Error(`Failed to download PDF: ${errorMessage}`);
    }
  }
});
const extractTextStep = createStep({
  id: "extract-text",
  description: "Extracts text content from the PDF",
  inputSchema: z.object({
    success: z.boolean(),
    pdfPath: z.string(),
    error: z.string().optional()
  }),
  outputSchema: z.object({
    success: z.boolean(),
    textPath: z.string(),
    characterCount: z.number(),
    error: z.string().optional()
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("[Step 2] Extracting text from PDF...");
    try {
      const parsed = await extractTextFromPdf(inputData.pdfPath);
      const text = parsed.text;
      const absoluteTextPath = path.resolve(TEMP_TEXT_FILE);
      fs.writeFileSync(absoluteTextPath, text);
      logger?.info("[Step 2] Text extracted successfully", {
        characterCount: text.length,
        pageCount: parsed.numpages,
        textPath: absoluteTextPath
      });
      return {
        success: true,
        textPath: absoluteTextPath,
        characterCount: text.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("[Step 2] Failed to extract text", { error: errorMessage });
      throw new Error(`Failed to extract text: ${errorMessage}`);
    }
  }
});
const MAX_LINES_TO_PASS = 30;
const compareRosterStep = createStep({
  id: "compare-roster",
  description: "Compares current roster with previous version to detect changes",
  inputSchema: z.object({
    success: z.boolean(),
    textPath: z.string(),
    characterCount: z.number(),
    error: z.string().optional()
  }),
  outputSchema: z.object({
    hasChanged: z.boolean(),
    isFirstRun: z.boolean(),
    currentHash: z.string(),
    previousHash: z.string().optional(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    addedCount: z.number(),
    removedCount: z.number(),
    timestamp: z.string(),
    textPath: z.string()
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("[Step 3] Comparing roster with previous version...");
    ensureStorageDir();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const currentText = fs.readFileSync(inputData.textPath, "utf-8");
    const currentHash = crypto.createHash("md5").update(currentText).digest("hex");
    let previousHash;
    let previousText;
    try {
      previousHash = fs.existsSync(PREV_HASH_FILE) ? fs.readFileSync(PREV_HASH_FILE, "utf-8").trim() : void 0;
      previousText = fs.existsSync(PREV_ROSTER_FILE) ? fs.readFileSync(PREV_ROSTER_FILE, "utf-8") : void 0;
    } catch (error) {
      logger?.warn("[Step 3] Could not read previous files", { error });
    }
    if (!previousHash || !previousText) {
      logger?.info("[Step 3] First run - no previous data found");
      return {
        hasChanged: false,
        isFirstRun: true,
        currentHash,
        previousHash: void 0,
        addedLines: [],
        removedLines: [],
        addedCount: 0,
        removedCount: 0,
        timestamp,
        textPath: inputData.textPath
      };
    }
    const hasChanged = currentHash !== previousHash;
    if (!hasChanged) {
      logger?.info("[Step 3] No changes detected");
      return {
        hasChanged: false,
        isFirstRun: false,
        currentHash,
        previousHash,
        addedLines: [],
        removedLines: [],
        addedCount: 0,
        removedCount: 0,
        timestamp,
        textPath: inputData.textPath
      };
    }
    const currentLines = currentText.split("\n").filter((line) => line.trim());
    const previousLines = previousText.split("\n").filter((line) => line.trim());
    const currentSet = new Set(currentLines);
    const previousSet = new Set(previousLines);
    const allAddedLines = currentLines.filter((line) => !previousSet.has(line));
    const allRemovedLines = previousLines.filter((line) => !currentSet.has(line));
    logger?.info("[Step 3] Changes detected", {
      addedCount: allAddedLines.length,
      removedCount: allRemovedLines.length
    });
    return {
      hasChanged: true,
      isFirstRun: false,
      currentHash,
      previousHash,
      addedLines: allAddedLines.slice(0, MAX_LINES_TO_PASS),
      removedLines: allRemovedLines.slice(0, MAX_LINES_TO_PASS),
      addedCount: allAddedLines.length,
      removedCount: allRemovedLines.length,
      timestamp,
      textPath: inputData.textPath
    };
  }
});
const analyzeChangesStep = createStep({
  id: "analyze-changes",
  description: "Uses AI to analyze and summarize the roster changes",
  inputSchema: z.object({
    hasChanged: z.boolean(),
    isFirstRun: z.boolean(),
    currentHash: z.string(),
    previousHash: z.string().optional(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    addedCount: z.number(),
    removedCount: z.number(),
    timestamp: z.string(),
    textPath: z.string()
  }),
  outputSchema: z.object({
    hasChanged: z.boolean(),
    isFirstRun: z.boolean(),
    currentHash: z.string(),
    timestamp: z.string(),
    textPath: z.string(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    addedCount: z.number(),
    removedCount: z.number(),
    summary: z.string(),
    shouldNotify: z.boolean()
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("[Step 4] Analyzing changes...");
    if (inputData.isFirstRun) {
      logger?.info("[Step 4] First run - storing initial state");
      return {
        ...inputData,
        summary: "Initial roster captured. Future changes will be tracked and reported.",
        shouldNotify: false
      };
    }
    if (!inputData.hasChanged) {
      logger?.info("[Step 4] No changes detected");
      return {
        ...inputData,
        summary: "No changes detected in the roster.",
        shouldNotify: false
      };
    }
    const prompt = `
      Analyze these changes to the Mason County Jail Roster and provide a brief summary.
      
      Added lines (${inputData.addedCount} total, showing first ${inputData.addedLines.length}):
      ${inputData.addedLines.join("\n")}
      ${inputData.addedCount > inputData.addedLines.length ? `...and ${inputData.addedCount - inputData.addedLines.length} more` : ""}
      
      Removed lines (${inputData.removedCount} total, showing first ${inputData.removedLines.length}):
      ${inputData.removedLines.join("\n")}
      ${inputData.removedCount > inputData.removedLines.length ? `...and ${inputData.removedCount - inputData.removedLines.length} more` : ""}
      
      Provide a 2-4 sentence summary focusing on:
      - How many changes were detected
      - General nature of the changes (new bookings, releases, etc.)
      - Any notable patterns
      
      Be factual and objective.
    `;
    const response = await rosterAgent.generate(prompt);
    const summary = response.text || "Changes detected in the roster.";
    logger?.info("[Step 4] Analysis complete", { summary });
    return {
      ...inputData,
      summary,
      shouldNotify: true
    };
  }
});
const saveHistoryStep = createStep({
  id: "save-history",
  description: "Saves the current roster state and logs changes",
  inputSchema: z.object({
    hasChanged: z.boolean(),
    isFirstRun: z.boolean(),
    currentHash: z.string(),
    timestamp: z.string(),
    textPath: z.string(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    addedCount: z.number(),
    removedCount: z.number(),
    summary: z.string(),
    shouldNotify: z.boolean()
  }),
  outputSchema: z.object({
    hasChanged: z.boolean(),
    timestamp: z.string(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    addedCount: z.number(),
    removedCount: z.number(),
    summary: z.string(),
    shouldNotify: z.boolean(),
    historySaved: z.boolean()
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("[Step 5] Saving roster history...");
    ensureStorageDir();
    try {
      const currentText = fs.readFileSync(inputData.textPath, "utf-8");
      fs.writeFileSync(PREV_HASH_FILE, inputData.currentHash);
      fs.writeFileSync(PREV_ROSTER_FILE, currentText);
      if (inputData.hasChanged || inputData.isFirstRun) {
        const logEntry = `
================================================================================
${inputData.isFirstRun ? "Initial capture" : "Change detected"} at: ${inputData.timestamp}
================================================================================
${inputData.isFirstRun ? "Initial roster state captured." : `Added lines (${inputData.addedCount} total, showing ${inputData.addedLines.length}):
${inputData.addedLines.map((line) => `  + ${line}`).join("\n") || "  (none)"}

Removed lines (${inputData.removedCount} total, showing ${inputData.removedLines.length}):
${inputData.removedLines.map((line) => `  - ${line}`).join("\n") || "  (none)"}`}
`;
        fs.appendFileSync(CHANGE_LOG_FILE, logEntry);
        logger?.info("[Step 5] Change logged to history file");
      }
      logger?.info("[Step 5] History saved successfully");
      return {
        hasChanged: inputData.hasChanged,
        timestamp: inputData.timestamp,
        addedLines: inputData.addedLines,
        removedLines: inputData.removedLines,
        addedCount: inputData.addedCount,
        removedCount: inputData.removedCount,
        summary: inputData.summary,
        shouldNotify: inputData.shouldNotify,
        historySaved: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("[Step 5] Failed to save history", { error: errorMessage });
      return {
        hasChanged: inputData.hasChanged,
        timestamp: inputData.timestamp,
        addedLines: inputData.addedLines,
        removedLines: inputData.removedLines,
        addedCount: inputData.addedCount,
        removedCount: inputData.removedCount,
        summary: inputData.summary,
        shouldNotify: inputData.shouldNotify,
        historySaved: false
      };
    }
  }
});
const sendNotificationStep = createStep({
  id: "send-notification",
  description: "Sends email notification if changes were detected",
  inputSchema: z.object({
    hasChanged: z.boolean(),
    timestamp: z.string(),
    addedLines: z.array(z.string()),
    removedLines: z.array(z.string()),
    addedCount: z.number(),
    removedCount: z.number(),
    summary: z.string(),
    shouldNotify: z.boolean(),
    historySaved: z.boolean()
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    changesDetected: z.boolean(),
    notificationSent: z.boolean()
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("[Step 6] Processing notification...");
    if (!inputData.shouldNotify) {
      logger?.info("[Step 6] No notification needed");
      return {
        success: true,
        message: inputData.hasChanged ? "No changes detected" : "First run - baseline established",
        changesDetected: false,
        notificationSent: false
      };
    }
    logger?.info("[Step 6] Sending notification email...");
    try {
      const addedSection = inputData.addedCount > 0 ? `<h3 style="color: #28a745;">Added (${inputData.addedCount} total):</h3>
             <ul>${inputData.addedLines.map((line) => `<li>${line}</li>`).join("")}
             ${inputData.addedCount > inputData.addedLines.length ? `<li>...and ${inputData.addedCount - inputData.addedLines.length} more</li>` : ""}</ul>` : "";
      const removedSection = inputData.removedCount > 0 ? `<h3 style="color: #dc3545;">Removed (${inputData.removedCount} total):</h3>
             <ul>${inputData.removedLines.map((line) => `<li>${line}</li>`).join("")}
             ${inputData.removedCount > inputData.removedLines.length ? `<li>...and ${inputData.removedCount - inputData.removedLines.length} more</li>` : ""}</ul>` : "";
      const htmlContent = `
        <html>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #333;">Mason County Jail Roster Update</h1>
          <p><strong>Time:</strong> ${inputData.timestamp}</p>
          <hr style="border: 1px solid #ddd;">
          <h2>Summary</h2>
          <p>${inputData.summary}</p>
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
Time: ${inputData.timestamp}

Summary:
${inputData.summary}

Added (${inputData.addedCount} total):
${inputData.addedLines.map((line) => `+ ${line}`).join("\n")}
${inputData.addedCount > inputData.addedLines.length ? `...and ${inputData.addedCount - inputData.addedLines.length} more` : ""}

Removed (${inputData.removedCount} total):
${inputData.removedLines.map((line) => `- ${line}`).join("\n")}
${inputData.removedCount > inputData.removedLines.length ? `...and ${inputData.removedCount - inputData.removedLines.length} more` : ""}

View full roster: https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf
      `;
      const emailTo = process.env.NOTIFICATION_EMAIL || "admin@example.com";
      const emailSubject = `Mason County Jail Roster Updated - ${new Date(inputData.timestamp).toLocaleDateString()}`;
      const result = await sendEmail({
        to: emailTo,
        subject: emailSubject,
        html: htmlContent,
        text: textContent
      });
      logger?.info("[Step 6] Email sent successfully", {
        messageId: result.messageId,
        accepted: result.accepted
      });
      const fs2 = await import('fs');
      const emailLogPath = ".data/email_log.txt";
      const emailLogEntry = `
================================================================================
Email sent at: ${inputData.timestamp}
================================================================================
To: ${emailTo}
Subject: ${emailSubject}
Message ID: ${result.messageId}
Status: Delivered

Summary: ${inputData.summary}
Added: ${inputData.addedCount} | Removed: ${inputData.removedCount}
`;
      try {
        if (!fs2.existsSync(".data")) fs2.mkdirSync(".data", { recursive: true });
        fs2.appendFileSync(emailLogPath, emailLogEntry);
      } catch (e) {
        logger?.warn("Could not save email log", { error: String(e) });
      }
      return {
        success: true,
        message: `Changes detected and notification sent: ${inputData.summary}`,
        changesDetected: true,
        notificationSent: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("[Step 6] Failed to send email", { error: errorMessage });
      return {
        success: true,
        message: `Changes detected but email failed: ${errorMessage}`,
        changesDetected: true,
        notificationSent: false
      };
    }
  }
});
const rosterWorkflow = createWorkflow({
  id: "roster-monitor-workflow",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    changesDetected: z.boolean(),
    notificationSent: z.boolean()
  })
}).then(downloadPdfStep).then(extractTextStep).then(compareRosterStep).then(analyzeChangesStep).then(saveHistoryStep).then(sendNotificationStep).commit();

class ProductionPinoLogger extends MastraLogger {
  logger;
  constructor(options = {}) {
    super(options);
    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label, _number) => ({
          level: label
        })
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`
    });
  }
  debug(message, args = {}) {
    this.logger.debug(args, message);
  }
  info(message, args = {}) {
    this.logger.info(args, message);
  }
  warn(message, args = {}) {
    this.logger.warn(args, message);
  }
  error(message, args = {}) {
    this.logger.error(args, message);
  }
}
const mastra = new Mastra({
  storage: sharedPostgresStorage,
  workflows: {
    rosterWorkflow
  },
  agents: {
    rosterAgent
  },
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      tools: {}
    })
  },
  bundler: {
    externals: ["@slack/web-api", "inngest", "inngest/hono", "hono", "hono/streaming", "pdf-parse"],
    sourcemap: true
  },
  server: {
    host: "0.0.0.0",
    port: 5e3,
    middleware: [async (c, next) => {
      const mastra2 = c.get("mastra");
      const logger = mastra2?.getLogger();
      logger?.debug("[Request]", {
        method: c.req.method,
        url: c.req.url
      });
      try {
        await next();
      } catch (error) {
        logger?.error("[Response]", {
          method: c.req.method,
          url: c.req.url,
          error
        });
        if (error instanceof MastraError) {
          if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
            throw new NonRetriableError(error.message, {
              cause: error
            });
          }
        } else if (error instanceof z.ZodError) {
          throw new NonRetriableError(error.message, {
            cause: error
          });
        }
        throw error;
      }
    }],
    apiRoutes: [{
      path: "/",
      method: "GET",
      createHandler: async () => {
        return async (c) => {
          return c.redirect("/api/status");
        };
      }
    }, {
      path: "/api/inngest",
      method: "ALL",
      createHandler: async ({
        mastra: mastra2
      }) => inngestServe({
        mastra: mastra2,
        inngest
      })
    }, {
      path: "/api/status",
      method: "GET",
      createHandler: async () => {
        return async (c) => {
          const fs = await import('fs');
          const path = await import('path');
          const dataDir = ".data";
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
            let metrics = {
              statusViews: 0,
              historyViews: 0,
              emailViews: 0
            };
            if (!fs.existsSync(dataDir)) {
              fs.mkdirSync(dataDir, {
                recursive: true
              });
            }
            if (fs.existsSync(metricsFile)) {
              try {
                metrics = JSON.parse(fs.readFileSync(metricsFile, "utf-8"));
              } catch (e) {
              }
            }
            metrics.statusViews = (metrics.statusViews || 0) + 1;
            viewCount = metrics.statusViews;
            try {
              fs.writeFileSync(metricsFile, JSON.stringify(metrics));
            } catch (e) {
              console.error("Failed to write metrics:", e);
            }
          } catch (e) {
          }
          const html = `<!DOCTYPE html>
<html>
<head>
  <title>Mason County Jail Roster Monitor</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 8pt; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 500px; padding: 2rem; }
    h1 { font-family: 'Bebas Neue', sans-serif; font-size: 2rem; margin-bottom: 1.5rem; color: #38bdf8; letter-spacing: 1px; }
    .status { background: #1e293b; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; }
    .status-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
    .status-dot { width: 12px; height: 12px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .status-title { font-weight: 600; }
    .stats { display: grid; gap: 1rem; }
    .stat { display: flex; justify-content: space-between; padding: 0.75rem 0; border-bottom: 1px solid #334155; }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #94a3b8; }
    .stat-value { font-weight: 500; }
    .run-btn { display: block; width: 100%; padding: 0.75rem; margin-top: 1rem; background: #22c55e; color: #fff; text-align: center; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .run-btn:hover { background: #16a34a; }
    .footer { text-align: center; color: #64748b; font-size: 0.875rem; margin-top: 1.5rem; }
    a { color: #38bdf8; text-decoration: none; }
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
          <span class="stat-value">${lastCheck !== "Never" ? new Date(lastCheck).toLocaleString("en-US", {
            timeZone: "America/Los_Angeles",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            hour12: true
          }) + " PST" : "Never"}</span>
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
    </div>
    <div class="footer">
      <p><a href="/api/history">View Change History</a> | <a href="/api/emails">View Email History</a></p>
      <p style="margin-top: 0.5rem;">Monitoring <a href="https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf" target="_blank">Mason County Jail Roster</a></p>
    </div>
  </div>
</body>
</html>`;
          return c.html(html);
        };
      }
    }, {
      path: "/api/run",
      method: "GET",
      createHandler: async ({
        mastra: mastra2
      }) => {
        return async (c) => {
          const fs = await import('fs');
          const path = await import('path');
          const crypto = await import('crypto');
          const {
            PDFParse
          } = await import('pdf-parse');
          const PDF_URL = "https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf";
          const STORAGE_DIR = ".data";
          function ensureStorageDir() {
            if (!fs.existsSync(STORAGE_DIR)) {
              fs.mkdirSync(STORAGE_DIR, {
                recursive: true
              });
            }
          }
          try {
            let extractBookings2 = function(rosterText) {
              const bookings = /* @__PURE__ */ new Map();
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
                  if (t.includes("Statute") && t.includes("Offense")) {
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
            }, formatBooked2 = function(b) {
              return b.name + " | Booked: " + b.bookDate + " | Charges: " + (b.charges.join(", ") || "None listed");
            }, formatReleased2 = function(b) {
              return b.name + " | Released: " + b.releaseDate + " | Charges: " + (b.charges.join(", ") || "None listed");
            };
            ensureStorageDir();
            const response = await fetch(PDF_URL);
            if (!response.ok) {
              throw new Error("Failed to download PDF: " + response.status);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const pdfPath = path.join(STORAGE_DIR, "current.pdf");
            fs.writeFileSync(pdfPath, buffer);
            const parser = new PDFParse({
              data: buffer
            });
            const result = await parser.getText();
            const text = result.text;
            await parser.destroy();
            const textPath = path.join(STORAGE_DIR, "current_text.txt");
            fs.writeFileSync(textPath, text);
            const currentHash = crypto.createHash("md5").update(text).digest("hex");
            const timestamp = (/* @__PURE__ */ new Date()).toISOString();
            const hashFile = path.join(STORAGE_DIR, "prev_hash.txt");
            const rosterFile = path.join(STORAGE_DIR, "prev_roster.txt");
            const logFile = path.join(STORAGE_DIR, "change_log.txt");
            let previousHash;
            let previousText;
            let hasChanged = false;
            let isFirstRun = false;
            let addedLines = [];
            let removedLines = [];
            if (fs.existsSync(hashFile) && fs.existsSync(rosterFile)) {
              previousHash = fs.readFileSync(hashFile, "utf-8").trim();
              previousText = fs.readFileSync(rosterFile, "utf-8");
              hasChanged = currentHash !== previousHash;
              if (hasChanged) {
                const currentBookings = extractBookings2(text);
                const previousBookings = extractBookings2(previousText);
                for (const [id, booking] of currentBookings) {
                  if (!previousBookings.has(id)) {
                    addedLines.push(formatBooked2(booking));
                  }
                }
                for (const [id, booking] of previousBookings) {
                  if (!currentBookings.has(id)) {
                    removedLines.push(formatReleased2(booking));
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
            const logEntry = "\n================================================================================\n" + (isFirstRun ? "Initial capture" : hasChanged ? "Change detected" : "No change") + " at: " + timestamp + "\n================================================================================\n" + (isFirstRun ? "Initial roster state captured.\n" : hasChanged ? "BOOKED (" + addedLines.length + "):\n" + addedLines.map((l) => "  + " + l).join("\n") + "\n\nRELEASED (" + removedLines.length + "):\n" + removedLines.map((l) => "  - " + l).join("\n") + "\n" : "No changes detected.\n");
            fs.appendFileSync(logFile, logEntry);
            const message = isFirstRun ? "Initial roster captured successfully!" : hasChanged ? "Changes detected! " + addedLines.length + " new bookings, " + removedLines.length + " releases." : "No changes detected.";
            const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/api/status"><style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.success{color:#22c55e;font-size:3rem;margin-bottom:1rem;}h1{color:#38bdf8;margin-bottom:1rem;}p{color:#94a3b8;}</style></head><body><div class="container"><div class="success">\u2713</div><h1>Workflow Complete</h1><p>' + message + "</p><p>Redirecting to status page...</p></div></body></html>";
            return c.html(html);
          } catch (error) {
            const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.error{color:#ef4444;font-size:3rem;margin-bottom:1rem;}h1{color:#ef4444;margin-bottom:1rem;}p{color:#94a3b8;}a{color:#38bdf8;}</style></head><body><div class="container"><div class="error">\u2717</div><h1>Error</h1><p>' + (error.message || "Unknown error") + '</p><p><a href="/api/status">Back to Status</a></p></div></body></html>';
            return c.html(html);
          }
        };
      }
    }, {
      path: "/api/history",
      method: "GET",
      createHandler: async () => {
        return async (c) => {
          const fs = await import('fs');
          const path = await import('path');
          const dataDir = ".data";
          let changeLog = "";
          let entries = [];
          try {
            const logFile = path.join(dataDir, "change_log.txt");
            if (fs.existsSync(logFile)) {
              changeLog = fs.readFileSync(logFile, "utf-8");
              const sections = changeLog.split("================================================================================").filter((s) => s.trim());
              for (let i = 0; i < sections.length; i += 2) {
                const header = sections[i] || "";
                const content = sections[i + 1] || "";
                const timestampMatch = header.match(/(?:Change detected at|Initial capture at|No change at): (.+)/);
                if (timestampMatch) {
                  const addedMatch = content.match(/(?:BOOKED|New Bookings|Added lines) \((\d+)\):\n([\s\S]*?)(?=\n(?:RELEASED|Releases|Removed lines)|$)/);
                  const removedMatch = content.match(/(?:RELEASED|Releases|Removed lines) \((\d+)\):\n([\s\S]*?)$/);
                  const added = addedMatch ? addedMatch[2].split("\n").filter((l) => l.trim().startsWith("+")).map((l) => l.replace(/^\s*\+\s*/, "")) : [];
                  const removed = removedMatch ? removedMatch[2].split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.replace(/^\s*-\s*/, "")) : [];
                  entries.push({
                    timestamp: timestampMatch[1].trim(),
                    added,
                    removed
                  });
                }
              }
            }
          } catch (e) {
          }
          entries.reverse();
          const entriesHtml = entries.length > 0 ? entries.map((entry) => {
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
            const addedItems = entry.added.slice(0, 50).map((a) => "<li>" + a + "</li>").join("");
            const addedMore = entry.added.length > 50 ? "<li>...and " + (entry.added.length - 50) + " more</li>" : "";
            const addedHtml = entry.added.length > 0 ? '<div class="changes booked"><h4>BOOKED (' + entry.added.length + ")</h4><ul>" + addedItems + addedMore + "</ul></div>" : "";
            const removedItems = entry.removed.slice(0, 50).map((r) => "<li>" + r + "</li>").join("");
            const removedMore = entry.removed.length > 50 ? "<li>...and " + (entry.removed.length - 50) + " more</li>" : "";
            const removedHtml = entry.removed.length > 0 ? '<div class="changes released"><h4>RELEASED (' + entry.removed.length + ")</h4><ul>" + removedItems + removedMore + "</ul></div>" : "";
            const noChanges = !addedHtml && !removedHtml ? "<p class='no-changes'>Initial roster capture</p>" : "";
            return '<div class="entry"><div class="entry-header">' + pstDate + "</div>" + addedHtml + removedHtml + noChanges + "</div>";
          }).join("") : "<p class='no-data'>No changes recorded yet. Run the workflow to start monitoring.</p>";
          const html = '<!DOCTYPE html><html><head><title>Change History - Mason County Jail Roster Monitor</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: Arial, sans-serif; font-size: 8pt; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 2rem; } .container { max-width: 900px; margin: 0 auto; } h1 { font-size: 14pt; margin-bottom: 0.5rem; color: #38bdf8; } .subtitle { color: #64748b; margin-bottom: 2rem; } .back-link { display: inline-block; margin-bottom: 1.5rem; color: #38bdf8; text-decoration: none; } .back-link:hover { text-decoration: underline; } .entry { background: #1e293b; border-radius: 12px; padding: 1rem; margin-bottom: 1rem; } .entry-header { font-weight: 600; font-size: 10pt; margin-bottom: 0.75rem; color: #f8fafc; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; } .changes { margin-top: 0.75rem; } .changes h4 { font-size: 9pt; margin-bottom: 0.4rem; font-weight: bold; } .changes.booked h4 { color: #ef4444; } .changes.released h4 { color: #22c55e; } .changes ul { list-style: none; font-size: 8pt; color: #94a3b8; } .changes ul li { padding: 0.2rem 0; border-bottom: 1px solid #334155; } .changes ul li:last-child { border-bottom: none; } .no-changes { color: #64748b; font-style: italic; } .no-data { color: #64748b; text-align: center; padding: 3rem; } a { color: #38bdf8; }</style></head><body><div class="container"><a href="/api/status" class="back-link">Back to Status</a><h1>Change History</h1><p class="subtitle">Record of all detected changes in the jail roster (newest first)</p>' + entriesHtml + "</div></body></html>";
          return c.html(html);
        };
      }
    }, {
      path: "/api/emails",
      method: "GET",
      createHandler: async () => {
        return async (c) => {
          const fs = await import('fs');
          const path = await import('path');
          const dataDir = ".data";
          let emailLog = "";
          let emails = [];
          try {
            const logFile = path.join(dataDir, "email_log.txt");
            if (fs.existsSync(logFile)) {
              emailLog = fs.readFileSync(logFile, "utf-8");
              const sections = emailLog.split("================================================================================").filter((s) => s.trim());
              for (let i = 0; i < sections.length; i += 2) {
                const header = sections[i] || "";
                const content = sections[i + 1] || "";
                const timestampMatch = header.match(/Email sent at: (.+)/);
                const toMatch = content.match(/To: (.+)/);
                const subjectMatch = content.match(/Subject: (.+)/);
                const messageIdMatch = content.match(/Message ID: (.+)/);
                const summaryMatch = content.match(/Summary: (.+)/);
                if (timestampMatch) {
                  emails.push({
                    timestamp: timestampMatch[1].trim(),
                    to: toMatch ? toMatch[1].trim() : "",
                    subject: subjectMatch ? subjectMatch[1].trim() : "",
                    messageId: messageIdMatch ? messageIdMatch[1].trim() : "",
                    summary: summaryMatch ? summaryMatch[1].trim() : ""
                  });
                }
              }
            }
          } catch (e) {
            emailLog = "Error reading email log: " + String(e);
          }
          const emailsHtml = emails.length > 0 ? emails.reverse().map((email) => {
            const date = new Date(email.timestamp);
            const pstEmailDate = date.toLocaleString("en-US", {
              timeZone: "America/Los_Angeles",
              year: "numeric",
              month: "numeric",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              hour12: true
            }) + " PST";
            return '<div class="email"><div class="email-header">' + pstEmailDate + '</div><div class="email-details"><p><strong>To:</strong> ' + email.to + "</p><p><strong>Subject:</strong> " + email.subject + "</p><p><strong>Summary:</strong> " + email.summary + '</p><p class="message-id">Message ID: ' + email.messageId + "</p></div></div>";
          }).join("") : "<p class='no-data'>No emails sent yet. Emails are sent when roster changes are detected.</p>";
          const html = '<!DOCTYPE html><html><head><title>Email History - Mason County Jail Roster Monitor</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 2rem; } .container { max-width: 800px; margin: 0 auto; } h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #38bdf8; } .subtitle { color: #64748b; margin-bottom: 2rem; } .back-link { display: inline-block; margin-bottom: 1.5rem; color: #38bdf8; text-decoration: none; } .back-link:hover { text-decoration: underline; } .email { background: #1e293b; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; } .email-header { font-weight: 600; margin-bottom: 1rem; color: #22c55e; border-bottom: 1px solid #334155; padding-bottom: 0.75rem; } .email-details p { margin: 0.5rem 0; color: #94a3b8; } .email-details strong { color: #e2e8f0; } .message-id { font-size: 0.75rem; color: #64748b; margin-top: 1rem !important; } .no-data { color: #64748b; text-align: center; padding: 3rem; } a { color: #38bdf8; }</style></head><body><div class="container"><a href="/api/status" class="back-link">Back to Status</a><h1>Email History</h1><p class="subtitle">Record of all notification emails sent</p>' + emailsHtml + "</div></body></html>";
          return c.html(html);
        };
      }
    }]
  },
  logger: process.env.NODE_ENV === "production" ? new ProductionPinoLogger({
    name: "Mastra",
    level: "info"
  }) : new PinoLogger({
    name: "Mastra",
    level: "info"
  })
});
if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error("More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.");
}
if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error("More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.");
}

export { mastra };
