/** A newer durable snapshot must beat stale WebView storage, including explicit nulls. */
export function selectRecoverySnapshot(
  local: Record<string, unknown>,
  backend: Record<string, unknown>,
) {
  const timestamp = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return timestamp(backend.recoveryUpdatedAt) >
    timestamp(local.recoveryUpdatedAt)
    ? backend
    : local;
}
