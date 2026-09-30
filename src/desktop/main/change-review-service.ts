import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChangeDiffDto,
  ChangeFileDto,
  ChangeFileStatusDto,
  ChangeReviewDto,
  ConversationChangeSummaryDto,
} from "../shared/contracts.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_CHARS = 1024 * 1024;
const MAX_DIFF_PREVIEW_CHARS = 12 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

interface IndexEntry {
  mode: string;
  oid: string;
}

interface FileState {
  exists: boolean;
  size: number;
  hash?: string;
  bytes?: Buffer;
  tooLarge: boolean;
}

interface ReviewBaseline {
  generation: string;
  projectRoot: string;
  git: boolean;
  head?: string;
  branch?: string;
  dirtyPaths: Set<string>;
  dirtyStates: Map<string, FileState>;
  index: Map<string, IndexEntry>;
  turnId?: string;
}

interface InternalChange {
  dto: ChangeFileDto;
  oldPath: string;
  newPath: string;
  baseline: FileState;
  current: FileState;
  baselineIndex?: IndexEntry;
  currentIndex?: IndexEntry;
  fullDiff: string;
}

interface RawChange extends InternalChange {
  dto: ChangeFileDto & { status: Exclude<ChangeFileStatusDto, "renamed"> };
}

export class ChangeReviewService {
  private baseline: ReviewBaseline | undefined;
  private changes = new Map<string, InternalChange>();
  private keptFingerprints = new Set<string>();
  private nonGitActivity = new Map<string, ChangeFileStatusDto>();
  private refreshQueue: Promise<ChangeReviewDto> = Promise.resolve(emptyReview());

  async begin(projectRoot: string): Promise<ChangeReviewDto> {
    const generation = randomUUID();
    const repository = await inspectRepository(projectRoot);
    if (!repository) {
      this.baseline = { generation, projectRoot, git: false, dirtyPaths: new Set(), dirtyStates: new Map(), index: new Map() };
      this.changes.clear();
      this.keptFingerprints.clear();
      this.nonGitActivity.clear();
      return this.snapshot("tracking");
    }
    const [statusOutput, indexOutput] = await Promise.all([
      runGit(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
      runGit(projectRoot, ["ls-files", "--stage", "-z", "--", "."]),
    ]);
    const dirtyPaths = parseStatusPaths(statusOutput.stdout);
    const dirtyStates = new Map<string, FileState>();
    for (const relativePath of dirtyPaths) {
      dirtyStates.set(relativePath, await readProjectFile(projectRoot, relativePath));
    }
    this.baseline = {
      generation,
      projectRoot,
      git: true,
      head: repository.head,
      branch: repository.branch,
      dirtyPaths,
      dirtyStates,
      index: parseIndex(indexOutput.stdout),
    };
    this.changes.clear();
    this.keptFingerprints.clear();
    this.nonGitActivity.clear();
    return this.snapshot("tracking");
  }

  attachTurn(turnId: string): ChangeReviewDto {
    if (this.baseline) this.baseline.turnId = turnId;
    return this.snapshot("tracking");
  }

  clear(): ChangeReviewDto {
    this.baseline = undefined;
    this.changes.clear();
    this.keptFingerprints.clear();
    this.nonGitActivity.clear();
    return emptyReview();
  }

  noteFileActivity(changes: Array<{ path: string; action: "added" | "modified" | "deleted" }>): void {
    const baseline = this.baseline;
    if (!baseline) return;
    for (const change of changes) {
      const relativePath = safeRelativePath(baseline.projectRoot, change.path);
      if (!relativePath) continue;
      const status: ChangeFileStatusDto = change.action === "added" ? "added" : change.action === "deleted" ? "deleted" : "modified";
      this.nonGitActivity.set(relativePath, status);
    }
  }

  refresh(phase: "tracking" | "ready" = "tracking"): Promise<ChangeReviewDto> {
    this.refreshQueue = this.refreshQueue.then(() => this.refreshInternal(phase), () => this.refreshInternal(phase));
    return this.refreshQueue;
  }

  getDiff(changeId: string): ChangeDiffDto {
    const change = this.requireChange(changeId);
    return {
      changeId,
      path: change.dto.path,
      ...(change.dto.previousPath ? { previousPath: change.dto.previousPath } : {}),
      status: change.dto.status,
      additions: change.dto.additions,
      deletions: change.dto.deletions,
      binary: change.dto.binary,
      diff: change.fullDiff,
      truncated: change.fullDiff.length >= MAX_DIFF_CHARS || change.dto.diffTruncated,
    };
  }

  keep(changeId: string): ChangeReviewDto {
    const change = this.requireChange(changeId);
    this.keptFingerprints.add(changeFingerprint(change));
    change.dto.reviewState = "kept";
    return this.snapshot(this.currentPhase());
  }

  async revert(changeId: string): Promise<ChangeReviewDto> {
    const change = this.requireChange(changeId);
    const baseline = this.baseline;
    if (!baseline?.git || !change.dto.canRevert) {
      throw changeError("CHANGE_REVERT_UNSAFE", change.dto.revertBlockedReason ?? "Bu değişiklik güvenle geri alınamıyor.");
    }
    const repository = await inspectRepository(baseline.projectRoot);
    if (!repository || repository.head !== baseline.head || repository.branch !== baseline.branch) {
      throw changeError("CHANGE_REVIEW_STALE", "Git dalı veya HEAD inceleme sonrasında değişti. Otomatik geri alma yapılmadı.");
    }
    const currentIndex = parseIndex((await runGit(baseline.projectRoot, ["ls-files", "--stage", "-z", "--", "."])).stdout);
    if (change.dto.status === "renamed") {
      assertIndexUnchanged(change.oldPath, change.baselineIndex, currentIndex.get(change.oldPath));
      assertIndexUnchanged(change.newPath, change.currentIndex, currentIndex.get(change.newPath));
    } else {
      assertIndexUnchanged(change.oldPath, change.currentIndex, currentIndex.get(change.oldPath));
    }
    const currentNew = await readProjectFile(baseline.projectRoot, change.newPath);
    if (!sameFileState(currentNew, change.current)) {
      throw changeError("CHANGE_REVIEW_STALE", "Dosya inceleme sonrasında değişti. Kullanıcı değişikliklerini korumak için otomatik geri alma yapılmadı.");
    }
    if (change.dto.status === "renamed") {
      const currentOld = await readProjectFile(baseline.projectRoot, change.oldPath);
      if (currentOld.exists) {
        throw changeError("CHANGE_REVIEW_STALE", "Eski dosya yolu yeniden oluşturuldu. Kullanıcı değişikliklerini korumak için otomatik geri alma yapılmadı.");
      }
      await restoreFile(baseline.projectRoot, change.oldPath, change.baseline);
      await deleteVerifiedFile(baseline.projectRoot, change.newPath, change.current);
    } else if (!change.baseline.exists) {
      await deleteVerifiedFile(baseline.projectRoot, change.newPath, change.current);
    } else {
      await restoreFile(baseline.projectRoot, change.oldPath, change.baseline);
    }
    this.keptFingerprints.delete(changeFingerprint(change));
    return this.refresh("ready");
  }

  summary(): ConversationChangeSummaryDto {
    return summarize([...this.changes.values()].map((change) => change.dto), this.baseline?.git === false ? "observed" : "complete");
  }

  private async refreshInternal(phase: "tracking" | "ready"): Promise<ChangeReviewDto> {
    const baseline = this.baseline;
    if (!baseline) return emptyReview();
    if (!baseline.git) {
      this.changes = new Map([...this.nonGitActivity].map(([relativePath, status]) => {
        const id = stableId(baseline.generation, relativePath, relativePath);
        const dto: ChangeFileDto = {
          id, path: relativePath, status, additions: 0, deletions: 0, binary: false,
          diffTruncated: false, reviewState: "pending", canRevert: false,
          revertBlockedReason: "Git olmayan projelerde güvenilir başlangıç içeriği olmadan otomatik geri alma sunulmaz.",
        };
        return [id, {
          dto, oldPath: relativePath, newPath: relativePath,
          baseline: absentState(), current: absentState(), fullDiff: "",
        }];
      }));
      return this.snapshot("nonGit", "Git bulunamadı; yalnızca Codex'in yapılandırılmış dosya olayları gözlendi. Kabuk komutlarının oluşturduğu dosyalar eksik olabilir; otomatik geri alma devre dışı.");
    }
    const repository = await inspectRepository(baseline.projectRoot);
    if (!repository) return this.snapshot("error", "Git deposu artık kullanılamıyor.");
    const [statusOutput, indexOutput] = await Promise.all([
      runGit(baseline.projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
      runGit(baseline.projectRoot, ["ls-files", "--stage", "-z", "--", "."]),
    ]);
    const currentPaths = parseStatusPaths(statusOutput.stdout);
    const currentIndex = parseIndex(indexOutput.stdout);
    const candidates = new Set([...baseline.dirtyPaths, ...currentPaths]);
    for (const observed of this.nonGitActivity.keys()) {
      if (baseline.index.has(observed) || baseline.dirtyPaths.has(observed) || currentPaths.has(observed)) candidates.add(observed);
    }
    const raw: RawChange[] = [];
    for (const relativePath of [...candidates].sort()) {
      const before = await this.baselineState(relativePath);
      const after = await readProjectFile(baseline.projectRoot, relativePath);
      if (sameFileState(before, after)) continue;
      const status: RawChange["dto"]["status"] = !before.exists ? "added" : !after.exists ? "deleted" : "modified";
      const diff = await createDiff(relativePath, relativePath, before, after);
      const baselineIndex = baseline.index.get(relativePath);
      const nextIndex = currentIndex.get(relativePath);
      const canRevert = !before.tooLarge && !after.tooLarge
        && indexEntryEqual(baselineIndex, nextIndex)
        && repository.head === baseline.head && repository.branch === baseline.branch;
      const id = stableId(baseline.generation, relativePath, relativePath);
      const dto: RawChange["dto"] = {
        id,
        path: relativePath,
        status,
        additions: diff.additions,
        deletions: diff.deletions,
        binary: diff.binary,
        ...(diff.preview ? { diffPreview: diff.preview } : {}),
        diffTruncated: diff.truncated,
        reviewState: "pending",
        canRevert,
        ...(canRevert ? {} : { revertBlockedReason: revertBlockReason(before, after, baselineIndex, nextIndex, repository, baseline) }),
      };
      const change: RawChange = {
        dto, oldPath: relativePath, newPath: relativePath, baseline: before, current: after,
        ...(baselineIndex ? { baselineIndex } : {}),
        ...(nextIndex ? { currentIndex: nextIndex } : {}),
        fullDiff: diff.full,
      };
      if (this.keptFingerprints.has(changeFingerprint(change))) dto.reviewState = "kept";
      raw.push(change);
    }
    const combined = detectRenames(raw, baseline.generation);
    this.changes = new Map(combined.map((change) => [change.dto.id, change]));
    return this.snapshot(phase);
  }

  private async baselineState(relativePath: string): Promise<FileState> {
    const baseline = this.baseline!;
    const dirty = baseline.dirtyStates.get(relativePath);
    if (dirty) return cloneFileState(dirty);
    const index = baseline.index.get(relativePath);
    if (!index) return absentState();
    if (index.mode === "120000") {
      const link = await readBlob(baseline.projectRoot, index.oid);
      return { ...link, tooLarge: true };
    }
    if (index.mode !== "100644" && index.mode !== "100755") {
      return { exists: true, size: 0, hash: index.oid, tooLarge: true };
    }
    return readBlob(baseline.projectRoot, index.oid);
  }

  private snapshot(phase: ChangeReviewDto["phase"], message?: string): ChangeReviewDto {
    const baseline = this.baseline;
    const files = [...this.changes.values()].map((change) => structuredClone(change.dto));
    return {
      phase,
      git: baseline?.git ?? false,
      baselineDirty: Boolean(baseline?.dirtyPaths.size),
      ...(baseline?.turnId ? { turnId: baseline.turnId } : {}),
      ...(baseline?.branch ? { branch: baseline.branch } : {}),
      ...(baseline?.head ? { head: baseline.head } : {}),
      ...summarize(files, phase === "nonGit" ? "observed" : "complete"),
      files,
      updatedAt: Date.now(),
      ...(message ? { message } : {}),
    };
  }

  private currentPhase(): ChangeReviewDto["phase"] {
    if (!this.baseline) return "idle";
    return this.baseline.git ? "ready" : "nonGit";
  }

  private requireChange(changeId: string): InternalChange {
    const change = this.changes.get(changeId);
    if (!change) throw changeError("CHANGE_NOT_FOUND", "Değişiklik artık geçerli değil; paneli yenileyin.");
    return change;
  }
}

function detectRenames(raw: RawChange[], generation: string): InternalChange[] {
  const consumed = new Set<RawChange>();
  const result: InternalChange[] = [];
  const deleted = raw.filter((change) => change.dto.status === "deleted" && change.baseline.hash);
  const added = raw.filter((change) => change.dto.status === "added" && change.current.hash);
  for (const removal of deleted) {
    const matches = added.filter((addition) => !consumed.has(addition) && addition.current.hash === removal.baseline.hash);
    if (matches.length !== 1) continue;
    const addition = matches[0]!;
    consumed.add(removal);
    consumed.add(addition);
    const id = stableId(generation, removal.oldPath, addition.newPath);
    const canRevert = removal.dto.canRevert && addition.dto.canRevert;
    const dto: ChangeFileDto = {
      id,
      path: addition.newPath,
      previousPath: removal.oldPath,
      status: "renamed",
      additions: 0,
      deletions: 0,
      binary: removal.dto.binary || addition.dto.binary,
      diffPreview: `rename from ${removal.oldPath}\nrename to ${addition.newPath}`,
      diffTruncated: false,
      reviewState: removal.dto.reviewState === "kept" && addition.dto.reviewState === "kept" ? "kept" : "pending",
      canRevert,
      ...(canRevert ? {} : { revertBlockedReason: removal.dto.revertBlockedReason ?? addition.dto.revertBlockedReason }),
    };
    result.push({
      dto,
      oldPath: removal.oldPath,
      newPath: addition.newPath,
      baseline: removal.baseline,
      current: addition.current,
      ...(removal.baselineIndex ? { baselineIndex: removal.baselineIndex } : {}),
      ...(addition.currentIndex ? { currentIndex: addition.currentIndex } : {}),
      fullDiff: dto.diffPreview!,
    });
  }
  result.push(...raw.filter((change) => !consumed.has(change)));
  return result.sort((left, right) => left.dto.path.localeCompare(right.dto.path));
}

async function createDiff(oldPath: string, newPath: string, before: FileState, after: FileState): Promise<{
  full: string; preview: string; additions: number; deletions: number; binary: boolean; truncated: boolean;
}> {
  if (before.tooLarge || after.tooLarge || (before.exists && !before.bytes) || (after.exists && !after.bytes)) {
    const text = "Diff güvenli görüntüleme sınırını aşıyor. Dosya değişikliği gizlenmedi; otomatik geri alma devre dışı.";
    return { full: text, preview: text, additions: 0, deletions: 0, binary: false, truncated: true };
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "evren-change-review-"));
  const beforePath = path.join(temporary, "before");
  const afterPath = path.join(temporary, "after");
  try {
    await Promise.all([writeFile(beforePath, before.bytes ?? Buffer.alloc(0)), writeFile(afterPath, after.bytes ?? Buffer.alloc(0))]);
    const result = await runProcess("git", ["diff", "--no-index", "--no-color", "--unified=3", "--", beforePath, afterPath], temporary, [0, 1]);
    const raw = result.stdout.toString("utf8");
    const binary = raw.includes("Binary files ") || containsNul(before.bytes) || containsNul(after.bytes);
    const bodyStart = raw.search(/^@@|^Binary files /m);
    const body = bodyStart >= 0 ? raw.slice(bodyStart).trimEnd() : "";
    const header = `--- ${before.exists ? `a/${oldPath}` : "/dev/null"}\n+++ ${after.exists ? `b/${newPath}` : "/dev/null"}`;
    const fullUnbounded = body ? `${header}\n${binary ? "Binary files differ" : body}` : header;
    const additions = binary ? 0 : body.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = binary ? 0 : body.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const full = fullUnbounded.slice(0, MAX_DIFF_CHARS);
    const preview = full.slice(0, MAX_DIFF_PREVIEW_CHARS);
    return {
      full,
      preview,
      additions,
      deletions,
      binary,
      truncated: fullUnbounded.length > MAX_DIFF_PREVIEW_CHARS,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function inspectRepository(projectRoot: string): Promise<{ head: string; branch: string } | undefined> {
  try {
    const inside = (await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"])).stdout.toString("utf8").trim();
    if (inside !== "true") return undefined;
    const [head, branch] = await Promise.all([
      runGit(projectRoot, ["rev-parse", "HEAD"]),
      runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    return { head: head.stdout.toString("utf8").trim(), branch: branch.stdout.toString("utf8").trim() };
  } catch {
    return undefined;
  }
}

function parseStatusPaths(output: Buffer): Set<string> {
  const entries = output.toString("utf8").split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const relativePath = normalizeGitPath(entry.slice(3));
    if (relativePath) paths.add(relativePath);
    if (code.includes("R") || code.includes("C")) {
      const paired = normalizeGitPath(entries[index + 1] ?? "");
      if (paired) paths.add(paired);
      index += 1;
    }
  }
  return paths;
}

function parseIndex(output: Buffer): Map<string, IndexEntry> {
  const result = new Map<string, IndexEntry>();
  for (const entry of output.toString("utf8").split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const metadata = entry.slice(0, tab).split(" ");
    const relativePath = normalizeGitPath(entry.slice(tab + 1));
    if (!relativePath || metadata.length !== 3 || metadata[2] !== "0") continue;
    result.set(relativePath, { mode: metadata[0]!, oid: metadata[1]! });
  }
  return result;
}

async function readProjectFile(projectRoot: string, relativePath: string): Promise<FileState> {
  const absolute = resolveProjectPath(projectRoot, relativePath);
  try {
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute), "utf8");
      return { exists: true, size: target.length, hash: hashBytes(target), tooLarge: true };
    }
    if (!details.isFile()) {
      return { exists: true, size: details.size, hash: hashBytes(Buffer.from(`special:${details.mode}`)), tooLarge: true };
    }
    if (details.size > MAX_FILE_BYTES) return { exists: true, size: details.size, hash: await hashFile(absolute), tooLarge: true };
    const bytes = await readFile(absolute);
    return { exists: true, size: bytes.length, bytes, hash: hashBytes(bytes), tooLarge: false };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return absentState();
    throw error;
  }
}

async function readBlob(projectRoot: string, oid: string): Promise<FileState> {
  const sizeResult = await runGit(projectRoot, ["cat-file", "-s", oid]);
  const size = Number(sizeResult.stdout.toString("utf8").trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid_git_blob_size");
  if (size > MAX_FILE_BYTES) return { exists: true, size, hash: oid, tooLarge: true };
  const content = await runGit(projectRoot, ["cat-file", "blob", oid], MAX_FILE_BYTES + 1024);
  return { exists: true, size: content.stdout.length, bytes: content.stdout, hash: hashBytes(content.stdout), tooLarge: false };
}

async function restoreFile(projectRoot: string, relativePath: string, baseline: FileState): Promise<void> {
  if (!baseline.exists || !baseline.bytes) throw changeError("CHANGE_REVERT_UNSAFE", "Güvenilir başlangıç içeriği bulunamadı.");
  const absolute = resolveProjectPath(projectRoot, relativePath);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(absolute), { recursive: true }));
  await writeFile(absolute, baseline.bytes);
}

async function deleteVerifiedFile(projectRoot: string, relativePath: string, expected: FileState): Promise<void> {
  const absolute = resolveProjectPath(projectRoot, relativePath);
  const current = await readProjectFile(projectRoot, relativePath);
  if (!sameFileState(current, expected)) throw changeError("CHANGE_REVIEW_STALE", "Dosya değişti; otomatik silme yapılmadı.");
  await unlink(absolute);
}

function resolveProjectPath(projectRoot: string, relativePath: string): string {
  const normalizedRoot = path.resolve(projectRoot);
  const absolute = path.resolve(normalizedRoot, relativePath.split("/").join(path.sep));
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw changeError("CHANGE_PATH_OUTSIDE_PROJECT", "Değişiklik yolu etkin projenin dışında.");
  }
  return absolute;
}

function safeRelativePath(projectRoot: string, value: string): string | undefined {
  const candidate = path.isAbsolute(value) ? path.relative(projectRoot, value) : value;
  const normalized = normalizeGitPath(candidate.split(path.sep).join("/"));
  if (!normalized) return undefined;
  try {
    resolveProjectPath(projectRoot, normalized);
    return normalized;
  } catch {
    return undefined;
  }
}

function normalizeGitPath(value: string): string | undefined {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return undefined;
  return /[\u0000-\u001f\u007f]/.test(normalized) ? undefined : normalized;
}

function summarize(files: ChangeFileDto[], coverage: "complete" | "observed"): ConversationChangeSummaryDto {
  return {
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    created: files.filter((file) => file.status === "added").length,
    modified: files.filter((file) => file.status === "modified").length,
    deleted: files.filter((file) => file.status === "deleted").length,
    renamed: files.filter((file) => file.status === "renamed").length,
    coverage,
  };
}

function emptyReview(): ChangeReviewDto {
  return {
    phase: "idle", git: false, baselineDirty: false, files: [], filesChanged: 0,
    additions: 0, deletions: 0, created: 0, modified: 0, deleted: 0, renamed: 0,
  };
}

function absentState(): FileState {
  return { exists: false, size: 0, tooLarge: false };
}

function cloneFileState(value: FileState): FileState {
  return { ...value, ...(value.bytes ? { bytes: Buffer.from(value.bytes) } : {}) };
}

function sameFileState(left: FileState, right: FileState): boolean {
  if (left.exists !== right.exists || left.size !== right.size || left.tooLarge !== right.tooLarge) return false;
  if (!left.exists) return true;
  return left.hash !== undefined && right.hash !== undefined && left.hash === right.hash;
}

function indexEntryEqual(left: IndexEntry | undefined, right: IndexEntry | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.mode === right.mode && left.oid === right.oid;
}

function assertIndexUnchanged(relativePath: string, expected: IndexEntry | undefined, actual: IndexEntry | undefined): void {
  if (!indexEntryEqual(expected, actual)) {
    throw changeError("CHANGE_REVIEW_STALE", `${relativePath} için Git index durumu değişti. Otomatik geri alma yapılmadı.`);
  }
}

function revertBlockReason(
  before: FileState,
  after: FileState,
  baselineIndex: IndexEntry | undefined,
  currentIndex: IndexEntry | undefined,
  repository: { head: string; branch: string },
  baseline: ReviewBaseline,
): string {
  if (before.tooLarge || after.tooLarge) return "Dosya güvenli geri alma boyut sınırını aşıyor.";
  if (!indexEntryEqual(baselineIndex, currentIndex)) return "Git index/staging durumu değişti; kullanıcı staging verisini korumak için geri alma devre dışı.";
  if (repository.head !== baseline.head || repository.branch !== baseline.branch) return "Git dalı veya HEAD başlangıçtan sonra değişti.";
  return "Değişikliğin yalnızca Codex'e ait olduğu güvenle doğrulanamadı.";
}

function changeFingerprint(change: InternalChange): string {
  return `${change.oldPath}\0${change.newPath}\0${change.baseline.hash ?? "absent"}\0${change.current.hash ?? "absent"}`;
}

function stableId(generation: string, oldPath: string, newPath: string): string {
  return createHash("sha256").update(`${generation}\0${oldPath}\0${newPath}`, "utf8").digest("hex").slice(0, 32);
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function containsNul(value: Buffer | undefined): boolean {
  return value?.includes(0) ?? false;
}

function runGit(cwd: string, args: string[], maximum = MAX_GIT_OUTPUT_BYTES): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return runProcess("git", ["-c", "core.quotepath=false", ...args], cwd, [0], maximum);
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  acceptedExitCodes: number[],
  maximum = MAX_GIT_OUTPUT_BYTES,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const append = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximum) {
        child.kill();
        if (!settled) {
          settled = true;
          reject(new Error("process_output_limit_exceeded"));
        }
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code !== null && acceptedExitCodes.includes(code)) resolve(result);
      else reject(new Error(result.stderr.toString("utf8").trim() || `${executable}_failed_${code}`));
    });
  });
}

function changeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
