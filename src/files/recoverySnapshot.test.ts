import { expect, it } from "vitest";
import { selectRecoverySnapshot } from "./recoverySnapshot";

it("uses the latest snapshot including an intentionally cleared file draft", () => {
  const local = { recoveryUpdatedAt: 100, fileRecovery: { draft: "old" } };
  const backend = { recoveryUpdatedAt: 200, fileRecovery: null };
  expect(selectRecoverySnapshot(local, backend)).toBe(backend);
  expect(selectRecoverySnapshot(backend, local)).toBe(backend);
});
it("preserves legacy local precedence and ignores malformed timestamps", () => {
  const local = { queryWorkspace: "legacy" };
  expect(selectRecoverySnapshot(local, {})).toBe(local);
  expect(selectRecoverySnapshot(local, { recoveryUpdatedAt: Infinity })).toBe(
    local,
  );
});
