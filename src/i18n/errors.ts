type Translate = (id: string, values?: Record<string, string | number | boolean | Date | null | undefined>) => string;

const ERROR_MESSAGE_IDS: Record<string, string> = {
  "files.inspect": "error.files.inspect",
  "preview.load": "error.preview.load",
  "preview.thumbnail": "error.preview.load",
  "preview.invalidMask": "error.preview.invalidMask",
  "preview.invalidEdge": "error.preview.invalidEdge",
  "preview.generateMask": "error.preview.generate",
  "preview.generateSam": "error.preview.generateSam",
  "preview.cacheClear": "error.preview.cacheClear",
  "model.status": "error.model.status",
  "model.install": "error.model.install",
  "model.delete": "error.model.delete",
  "diagnostics.load": "error.diagnostics.load",
  "output.plan": "error.output.plan",
  "batch.invalidSettings": "error.output.invalid",
  "batch.empty": "error.batch.empty",
  "batch.busy": "error.batch.busy",
  "batch.run": "error.batch.run",
  "workspace.load": "error.workspace.load",
  "workspace.save": "error.workspace.save",
  "workspace.clear": "error.workspace.clear",
  "preferences.load": "error.preferences.load",
  "preferences.save": "error.preferences.save",
  "preferences.reset": "error.preferences.reset",
};

interface CommandErrorPayload {
  code: string;
  detail?: string;
}

function parseCommandError(error: unknown): CommandErrorPayload | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error as CommandErrorPayload;
  if (typeof error !== "string") return null;
  try {
    const parsed = JSON.parse(error) as unknown;
    return parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string" ? parsed as CommandErrorPayload : null;
  } catch {
    return null;
  }
}

export function localizeCommandError(error: unknown, t: Translate, fallbackId = "error.generic"): string {
  const payload = parseCommandError(error);
  return t(payload ? ERROR_MESSAGE_IDS[payload.code] ?? fallbackId : fallbackId);
}

export function commandErrorDetail(error: unknown): string | null {
  return parseCommandError(error)?.detail ?? (typeof error === "string" ? error : null);
}
