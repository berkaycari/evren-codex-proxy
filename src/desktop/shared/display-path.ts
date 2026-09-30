export function projectNameFromPath(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}

export function displayProjectLocation(value: string, projectRoot?: string): string {
  if (!projectRoot) return projectNameFromPath(value);
  const candidate = normalizeWindowsPath(value);
  const root = normalizeWindowsPath(projectRoot);
  if (candidate.toLocaleLowerCase("en-US") === root.toLocaleLowerCase("en-US")) return "Project root";
  const prefix = `${root}\\`.toLocaleLowerCase("en-US");
  if (candidate.toLocaleLowerCase("en-US").startsWith(prefix)) return candidate.slice(root.length + 1).replace(/\\/g, "/");
  return projectNameFromPath(candidate);
}

export function displayFilePath(value: string, projectRoot?: string): string {
  return displayProjectLocation(value, projectRoot);
}

export function displayDiff(diff: string, projectRoot?: string): string {
  if (!projectRoot) return diff;
  const variants = [projectRoot, projectRoot.replace(/\\/g, "/")];
  return variants.reduce((current, root) => current.split(root).join("."), diff);
}

function normalizeWindowsPath(value: string): string {
  return value.trim().replace(/\//g, "\\").replace(/\\+/g, "\\").replace(/\\$/, "");
}
