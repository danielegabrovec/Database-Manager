import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import { errorMessage } from "../utils";
export function PathInput({
  value,
  onChange,
  kind = "open",
  placeholder,
  filters,
}: {
  value: string;
  onChange: (value: string) => void;
  kind?: "open" | "save" | "directory";
  placeholder?: string;
  filters?: { name: string; extensions: string[] }[];
}) {
  const [error, setError] = useState("");
  async function browse() {
    setError("");
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const path =
        kind === "save"
          ? await dialog.save({ defaultPath: value || undefined, filters })
          : await dialog.open({
              directory: kind === "directory",
              multiple: false,
              defaultPath: value || undefined,
              filters,
            });
      if (typeof path === "string") onChange(path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <span className="path-input">
      <span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {isTauri() && (
          <button
            type="button"
            className="icon-button"
            aria-label={
              kind === "directory" ? "Scegli cartella" : "Scegli file"
            }
            onClick={browse}
          >
            <FolderOpen size={16} />
          </button>
        )}
      </span>
      {error && <small className="path-error">{error}</small>}
    </span>
  );
}
