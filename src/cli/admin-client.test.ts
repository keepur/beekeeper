import { describe, it, expect } from "vitest";
import { formatAge, renderTable } from "./admin-client.js";

describe("renderTable", () => {
  it("returns '(none)' for empty rows", () => {
    expect(renderTable(["A", "B"], [])).toBe("(none)");
  });

  it("right-pads columns to longest cell + header", () => {
    const out = renderTable(
      ["NAME", "VALUE"],
      [
        ["a", "1"],
        ["bb", "22"],
      ],
    );
    const lines = out.split("\n");
    // Line 0 = header. NAME has width 4 (header), VALUE has width 5 (header).
    expect(lines[0]).toBe("NAME  VALUE");
    // Line 1 = separator (dashes matching header widths).
    expect(lines[1]).toBe("----  -----");
    // Body rows pad to the column widths.
    expect(lines[2]).toBe("a     1");
    expect(lines[3]).toBe("bb    22");
  });

  it("treats missing cells as empty strings", () => {
    // Avoids crashing on jagged input — useful when a row from the API
    // omits an optional field.
    const out = renderTable(["A", "B"], [["a"]]);
    expect(out).toContain("a");
  });
});

describe("formatAge", () => {
  it("returns '-' for null/undefined/0", () => {
    expect(formatAge(null)).toBe("-");
    expect(formatAge(undefined)).toBe("-");
    expect(formatAge(0)).toBe("-");
  });

  it("formats sub-minute ages in seconds", () => {
    const now = 100_000;
    expect(formatAge(now - 5_000, now)).toBe("5s");
    expect(formatAge(now - 59_000, now)).toBe("59s");
  });

  it("formats sub-hour ages in minutes", () => {
    const now = 10_000_000;
    expect(formatAge(now - 60_000, now)).toBe("1m");
    expect(formatAge(now - 59 * 60_000, now)).toBe("59m");
  });

  it("formats sub-day ages in hours", () => {
    const now = 100_000_000;
    expect(formatAge(now - 3_600_000, now)).toBe("1h");
    expect(formatAge(now - 23 * 3_600_000, now)).toBe("23h");
  });

  it("formats older ages in days", () => {
    const now = 1_000_000_000;
    expect(formatAge(now - 86_400_000, now)).toBe("1d");
    expect(formatAge(now - 7 * 86_400_000, now)).toBe("7d");
  });

  it("clamps negative diffs (clock skew) to 0s", () => {
    const now = 100_000;
    expect(formatAge(now + 5_000, now)).toBe("0s");
  });

  it("accepts ISO date strings (the /devices endpoint format)", () => {
    // Required because /devices returns pairedAt/lastSeenAt as ISO strings,
    // not ms timestamps, and the same renderer handles both.
    const now = Date.parse("2026-04-29T20:00:00.000Z");
    expect(formatAge("2026-04-29T19:59:55.000Z", now)).toBe("5s");
    expect(formatAge("2026-04-28T20:00:00.000Z", now)).toBe("1d");
  });

  it("returns '-' for unparseable strings and empty input", () => {
    const now = 100_000;
    expect(formatAge("not-a-date", now)).toBe("-");
    expect(formatAge("", now)).toBe("-");
  });
});
