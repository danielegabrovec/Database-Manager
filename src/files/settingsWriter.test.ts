import { describe, expect, it, vi } from "vitest";
import { createSettingsWriter } from "./settingsWriter";

describe("ordered workspace persistence", () => {
  it("waits for old writes and coalesces pending settings while retaining unrelated fields", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi
      .fn()
      .mockImplementationOnce(() => hold)
      .mockResolvedValue(undefined);
    const writer = createSettingsWriter(save);
    const first = writer.write({ queryWorkspace: "older" });
    const second = writer.write({
      queryWorkspace: "middle",
      fileRecovery: "file",
    });
    const last = writer.write({ queryWorkspace: "latest" });
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, last]);
    expect(save.mock.calls).toEqual([
      [{ queryWorkspace: "older" }],
      [{ queryWorkspace: "latest", fileRecovery: "file" }],
    ]);
  });
  it("reports failures and continues processing a later explicit retry", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const writer = createSettingsWriter(save);
    await expect(writer.write({ fileRecovery: "draft" })).rejects.toThrow(
      "disk full",
    );
    await expect(
      writer.write({ fileRecovery: "new draft" }),
    ).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
  });
});
