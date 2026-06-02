import { execSync } from "child_process";
import { describe, it, expect } from "vitest";

describe("Branding consistency", () => {
  it("has no remaining old brand name references in source files", () => {
    // Search for the old name split into parts to avoid this test matching itself
    const oldName = "Follow" + " " + "Builders";
    const result = execSync(
      `grep -r "${oldName}" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.sql" . ` +
        "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next " +
        "|| true",
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    expect(result.trim()).toBe("");
  });

  it("has no accidental old digest title references in source files", () => {
    const oldTitle = "AI" + " Builders" + " Digest";
    const result = execSync(
      `grep -r "${oldTitle}" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.sql" . ` +
        "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next " +
        "|| true",
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    expect(result.trim()).toBe("");
  });
});
