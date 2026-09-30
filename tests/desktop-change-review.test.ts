import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeReviewService } from "../src/desktop/main/change-review-service.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
  return result.stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "evren-change-review-test-"));
  temporaryDirectories.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "evren@example.invalid");
  await git(root, "config", "user.name", "EVREN Test");
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n", "utf8");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "baseline");
  return root;
}

describe("Desktop change review", () => {
  it("tracks a clean baseline modification and safely restores it", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    await writeFile(path.join(root, "tracked.txt"), "one\ntwo\nthree\n", "utf8");
    const review = await service.refresh("ready");
    expect(review).toMatchObject({ filesChanged: 1, additions: 1, deletions: 0, modified: 1, baselineDirty: false });
    expect(service.getDiff(review.files[0]!.id).diff).toContain("+three");
    await service.revert(review.files[0]!.id);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("preserves a pre-existing tracked user modification", async () => {
    const root = await repository();
    await writeFile(path.join(root, "tracked.txt"), "one\ntwo\nuser\n", "utf8");
    const service = new ChangeReviewService();
    const baseline = await service.begin(root);
    expect(baseline.baselineDirty).toBe(true);
    await writeFile(path.join(root, "tracked.txt"), "one\ntwo\nuser\nagent\n", "utf8");
    const review = await service.refresh("ready");
    expect(service.getDiff(review.files[0]!.id).diff).toContain("+agent");
    expect(service.getDiff(review.files[0]!.id).diff).not.toContain("+user");
    await service.revert(review.files[0]!.id);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("one\ntwo\nuser\n");
  });

  it("preserves and restores a pre-existing untracked file baseline", async () => {
    const root = await repository();
    await writeFile(path.join(root, "notes.txt"), "user\n", "utf8");
    const service = new ChangeReviewService();
    await service.begin(root);
    await writeFile(path.join(root, "notes.txt"), "user\nagent\n", "utf8");
    const review = await service.refresh("ready");
    expect(review.files[0]).toMatchObject({ path: "notes.txt", status: "modified", canRevert: true });
    await service.revert(review.files[0]!.id);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("user\n");
  });

  it("deletes an agent-created file only while its reviewed content is unchanged", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    await writeFile(path.join(root, "created.txt"), "agent\n", "utf8");
    const review = await service.refresh("ready");
    expect(review.files[0]).toMatchObject({ status: "added", canRevert: true });
    await writeFile(path.join(root, "created.txt"), "agent\nuser later\n", "utf8");
    await expect(service.revert(review.files[0]!.id)).rejects.toMatchObject({ code: "CHANGE_REVIEW_STALE" });
    expect(await readFile(path.join(root, "created.txt"), "utf8")).toContain("user later");
  });

  it("restores a tracked file deleted during the turn", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    await unlink(path.join(root, "tracked.txt"));
    const review = await service.refresh("ready");
    expect(review.files[0]).toMatchObject({ status: "deleted", deletions: 2, canRevert: true });
    await service.revert(review.files[0]!.id);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("aggregates multiple command-created changes with exact line counts", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    await writeFile(path.join(root, "tracked.txt"), "one\nchanged\n", "utf8");
    await writeFile(path.join(root, "new.txt"), "a\nb\n", "utf8");
    const review = await service.refresh("ready");
    expect(review).toMatchObject({ filesChanged: 2, additions: 3, deletions: 1, created: 1, modified: 1 });
  });

  it("refuses automatic revert after staging/index changes", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    await writeFile(path.join(root, "tracked.txt"), "agent\n", "utf8");
    await git(root, "add", "tracked.txt");
    const review = await service.refresh("ready");
    expect(review.files[0]).toMatchObject({ canRevert: false });
    expect(review.files[0]!.revertBlockedReason).toContain("index");
  });

  it("detects an exact-content unstaged rename and reverses both paths", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    await writeFile(path.join(root, "renamed.txt"), await readFile(path.join(root, "tracked.txt")));
    await unlink(path.join(root, "tracked.txt"));
    const review = await service.refresh("ready");
    expect(review.files).toHaveLength(1);
    expect(review.files[0]).toMatchObject({ status: "renamed", previousPath: "tracked.txt", path: "renamed.txt", canRevert: true });
    await service.revert(review.files[0]!.id);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("one\ntwo\n");
    await expect(readFile(path.join(root, "renamed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks keep as review metadata without staging the file", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    await writeFile(path.join(root, "tracked.txt"), "kept\n", "utf8");
    const review = await service.refresh("ready");
    expect(service.keep(review.files[0]!.id).files[0]!.reviewState).toBe("kept");
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
  });

  it("shows non-Git file activity without destructive revert", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evren-change-review-nongit-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"));
    const service = new ChangeReviewService();
    await service.begin(root);
    service.noteFileActivity([{ path: "src/file.ts", action: "modified" }]);
    const review = await service.refresh("ready");
    expect(review).toMatchObject({ phase: "nonGit", git: false, filesChanged: 1, coverage: "observed" });
    expect(review.files[0]).toMatchObject({ canRevert: false });
    expect(review.message).toContain("Kabuk komutlarının oluşturduğu dosyalar eksik olabilir");
    expect(service.summary()).toMatchObject({ filesChanged: 1, additions: 0, deletions: 0, coverage: "observed" });
  });

  it("ignores renderer-irrelevant activity outside the selected project", async () => {
    const root = await repository();
    const service = new ChangeReviewService();
    await service.begin(root);
    service.noteFileActivity([{ path: path.resolve(root, "..", "outside.txt"), action: "added" }]);
    expect((await service.refresh("ready")).files).toEqual([]);
  });
});
