import { describe, expect, it } from "vitest";
import { backupDefaultName } from "./sessions";

describe("backupDefaultName", () => {
  it("formats all-project backup names with timestamp", () => {
    expect(backupDefaultName("all", new Date("2026-05-21T09:08:00"))).toBe(
      "claude-deck-backup-all-20260521-0908.tar.gz"
    );
  });

  it("sanitizes project folder names", () => {
    expect(
      backupDefaultName("-Users-txf-foo/with spaces?#", new Date("2026-05-21T09:08:00"))
    ).toBe("claude-deck-backup--Users-txf-foo_with_spaces__-20260521-0908.tar.gz");
  });
});
