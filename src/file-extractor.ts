/**
 * File content extractor — PDF, DOCX, XLSX, CSV, text.
 * Optional deps (pdf-parse, mammoth, xlsx) are dynamically imported.
 * If not installed, extraction fails gracefully.
 */

import { extname } from "node:path";
import { createLogger } from "./logging/logger.js";

const log = createLogger("beekeeper-file-extractor");

const TEXT_TYPES = new Set([
  "csv", "tsv", "txt", "text", "md", "markdown",
  "json", "xml", "html", "yaml", "yml", "log",
]);

export async function extractContent(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<{ textContent: string | null } | null> {
  const ext = extname(filename).slice(1).toLowerCase();

  // Text-based files
  if (TEXT_TYPES.has(ext) || mimetype.startsWith("text/")) {
    return { textContent: truncate(buffer.toString("utf-8")) };
  }

  // PDF
  if (ext === "pdf" || mimetype === "application/pdf") {
    try {
      const pdfModule = await import("pdf-parse");
      const pdfParse = (pdfModule as any).default ?? pdfModule;
      const result = await pdfParse(buffer);
      return { textContent: truncate(result.text) };
    } catch (e: any) {
      log.warn("PDF parse failed", { name: filename, error: e.message });
      return { textContent: "[PDF — could not extract text]" };
    }
  }

  // DOCX
  if (ext === "docx" || mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return { textContent: truncate(result.value) };
    } catch (e: any) {
      log.warn("DOCX parse failed", { name: filename, error: e.message });
      return { textContent: "[DOCX — could not extract text]" };
    }
  }

  // XLSX
  if (ext === "xlsx" || ext === "xls" || mimetype.includes("spreadsheet")) {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = workbook.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
        return `--- Sheet: ${name} ---\n${csv}`;
      });
      return { textContent: truncate(sheets.join("\n\n")) };
    } catch (e: any) {
      log.warn("XLSX parse failed", { name: filename, error: e.message });
      return { textContent: "[Spreadsheet — could not extract content]" };
    }
  }

  // Unsupported
  return null;
}

function truncate(text: string, maxChars = 50_000): string {
  if (text.length <= maxChars) return text;
  const formatSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return text.slice(0, maxChars) + `\n\n[... truncated at ${formatSize(maxChars)} — full file at local path]`;
}
