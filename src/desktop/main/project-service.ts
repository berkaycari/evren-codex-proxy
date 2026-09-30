import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectDto, ProjectFileReferenceDto } from "../shared/contracts.js";

export class ProjectService {
  async open(projectPath: string): Promise<ProjectDto> {
    if (!path.isAbsolute(projectPath)) throw projectError("PROJECT_PATH_INVALID", "Proje yolu mutlak olmalıdır.");
    let canonical: string;
    try {
      canonical = await realpath(projectPath);
      const details = await stat(canonical);
      if (!details.isDirectory()) throw projectError("PROJECT_NOT_DIRECTORY", "Seçilen yol bir klasör değil.");
    } catch (error) {
      if (isProjectError(error)) throw error;
      throw projectError("PROJECT_NOT_FOUND", "Proje klasörü bulunamadı.");
    }
    return { path: canonical, name: path.basename(canonical) || canonical, exists: true };
  }

  async describeRecent(projectPaths: readonly string[]): Promise<ProjectDto[]> {
    const projects: ProjectDto[] = [];
    for (const projectPath of projectPaths.slice(0, 10)) {
      try {
        projects.push(await this.open(projectPath));
      } catch {
        projects.push({ path: path.normalize(projectPath), name: path.basename(projectPath) || projectPath, exists: false });
      }
    }
    return projects;
  }

  async projectFile(projectRoot: string, selectedPath: string): Promise<ProjectFileReferenceDto> {
    const project = await this.open(projectRoot);
    if (!path.isAbsolute(selectedPath)) throw projectError("PROJECT_FILE_INVALID", "Dosya yolu mutlak olmalıdır.");
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(selectedPath);
      if (!(await stat(canonicalFile)).isFile()) throw new Error("not_file");
    } catch {
      throw projectError("PROJECT_FILE_INVALID", "Seçilen proje dosyası bulunamadı.");
    }
    const relativePath = path.relative(project.path, canonicalFile);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw projectError("PROJECT_FILE_OUTSIDE_ROOT", "Yalnız etkin proje içindeki dosyalar seçilebilir.");
    }
    return { name: path.basename(canonicalFile), relativePath: relativePath.split(path.sep).join("/") };
  }
}

function projectError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isProjectError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("PROJECT_");
}
