import type { OpenDocument } from "../views/OpenFilesView";

export interface FileRecovery {
  version: 1;
  document: OpenDocument;
  draft: string;
  editing: boolean;
}

export const MAX_FILE_RECOVERY_CHARACTERS = 8 * 1024 * 1024;

export function needsFileRecovery(
  document: OpenDocument | null,
  draft: string,
) {
  return (
    !!document &&
    document.content !== null &&
    (draft !== document.content || (document.origin === "generated" && !!draft))
  );
}

/** Restore text only. Metadata never authorizes opening a database or executing code. */
export function restoreFileRecovery(value: unknown): FileRecovery | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<FileRecovery>;
  const file = source.document;
  if (
    source.version !== 1 ||
    !file ||
    typeof file !== "object" ||
    typeof source.draft !== "string" ||
    typeof file.content !== "string" ||
    source.draft.length + file.content.length > MAX_FILE_RECOVERY_CHARACTERS ||
    typeof file.name !== "string" ||
    !file.name ||
    file.name.length > 256 ||
    !["sql", "source", "text"].includes(file.kind) ||
    !["disk", "browser", "generated"].includes(file.origin)
  )
    return null;
  const optional = (value: unknown, max = 4096) =>
    typeof value === "string" && value.length <= max ? value : undefined;
  const path = optional(file.path);
  const fingerprint = optional(file.fingerprint, 256);
  const encoding = optional(file.encoding, 64);
  // Never restore a writable disk binding without its original conflict guard.
  if (file.origin === "disk" && (!path || !fingerprint || !encoding))
    return null;
  const document: OpenDocument = {
    name: file.name,
    kind: file.kind,
    extension: optional(file.extension, 32) ?? "txt",
    content: file.content,
    origin: file.origin,
    path: file.origin === "disk" ? path : undefined,
    fingerprint: file.origin === "disk" ? fingerprint : undefined,
    encoding: encoding ?? "utf-8",
    sizeBytes:
      Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0
        ? file.sizeBytes
        : 0,
    syntaxLanguage: optional(file.syntaxLanguage, 64) ?? "plaintext",
    requiresEncoding: false,
    readOnly: file.readOnly === true,
    originLabel: optional(file.originLabel, 256),
    generatedId: optional(file.generatedId, 128),
    warnings: Array.isArray(file.warnings)
      ? file.warnings
          .filter((item): item is string => typeof item === "string")
          .slice(0, 20)
          .map((item) => item.slice(0, 4096))
      : [],
  };
  return needsFileRecovery(document, source.draft)
    ? {
        version: 1,
        document,
        draft: source.draft,
        editing: source.editing === true,
      }
    : null;
}

export function captureFileRecovery(
  document: OpenDocument | null,
  draft: string,
  editing: boolean,
): FileRecovery | null {
  if (!needsFileRecovery(document, draft)) return null;
  if (document!.content!.length + draft.length > MAX_FILE_RECOVERY_CHARACTERS)
    throw new Error(
      "La bozza del centro file supera il limite di recupero automatico. Salvala su file per conservarla.",
    );
  return { version: 1, document: document!, draft, editing };
}
