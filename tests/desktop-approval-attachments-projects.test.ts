import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../src/desktop/main/attachment-service.js";
import { CodexApprovalService } from "../src/desktop/main/codex-approval-service.js";
import { ProjectService } from "../src/desktop/main/project-service.js";
import { parseDesktopSettings } from "../src/desktop/main/settings-service.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Phase 2 project and attachment safety", () => {
  it("canonicalizes existing directories without scanning their contents", async () => {
    const root = await temporaryDirectory();
    const nested = path.join(root, "project");
    await mkdir(nested);
    const project = await new ProjectService().open(nested);
    expect(project).toMatchObject({ path: nested, name: "project", exists: true });
    await expect(new ProjectService().open(path.join(root, "missing"))).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("keeps a bounded deduplicated recent-project setting and marks deleted folders gracefully", async () => {
    const root = await temporaryDirectory();
    const projects = Array.from({ length: 12 }, (_, index) => path.join(root, `project-${index}`));
    await mkdir(projects[0]!);
    const parsed = parseDesktopSettings({ recentProjects: [...projects, projects[0]] });
    expect(parsed.recentProjects).toHaveLength(10);
    const described = await new ProjectService().describeRecent(parsed.recentProjects!);
    expect(described[0]).toMatchObject({ exists: true, name: "project-0" });
    expect(described[1]).toMatchObject({ exists: false, name: "project-1" });
  });

  it("allows only real files contained by the active project", async () => {
    const root = await temporaryDirectory();
    const project = path.join(root, "project");
    const outside = path.join(root, "outside.txt");
    await mkdir(path.join(project, "src"), { recursive: true });
    const inside = path.join(project, "src", "app.ts");
    await writeFile(inside, "safe");
    await writeFile(outside, "outside");
    const service = new ProjectService();
    await expect(service.projectFile(project, inside)).resolves.toEqual({ name: "app.ts", relativePath: "src/app.ts" });
    await expect(service.projectFile(project, outside)).rejects.toMatchObject({ code: "PROJECT_FILE_OUTSIDE_ROOT" });
  });

  it.each([
    ["pixel.png", "image/png", validPng()],
    ["pixel.jpg", "image/jpeg", validJpeg()],
    ["pixel.webp", "image/webp", validWebp()],
  ] as const)("validates %s structure while returning metadata only", async (name, mimeType, bytes) => {
    const root = await temporaryDirectory();
    const imagePath = path.join(root, name);
    await writeFile(imagePath, bytes);
    const service = new AttachmentService();
    const attachment = await service.addImage(imagePath);
    expect(attachment).toMatchObject({ name, mimeType, sizeBytes: bytes.length });
    expect(JSON.stringify(attachment)).not.toContain("iVBOR");
    expect(JSON.stringify(attachment)).not.toContain(imagePath);
    expect((await service.resolve([attachment.id]))[0]?.path).toBe(imagePath);
  });

  it("rejects extension/signature disagreement before turn/start", async () => {
    const root = await temporaryDirectory();
    const fake = path.join(root, "fake.png");
    await writeFile(fake, Buffer.from("not an image"));
    await expect(new AttachmentService().addImage(fake)).rejects.toMatchObject({ code: "IMAGE_SIGNATURE_INVALID" });
  });

  it("rejects empty, truncated, and unsupported image files", async () => {
    const root = await temporaryDirectory();
    const empty = path.join(root, "empty.png");
    const truncated = path.join(root, "truncated.png");
    const unsupported = path.join(root, "pixel.gif");
    await writeFile(empty, Buffer.alloc(0));
    await writeFile(truncated, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
    await writeFile(unsupported, Buffer.from("GIF89a"));
    const service = new AttachmentService();
    await expect(service.addImage(empty)).rejects.toMatchObject({ code: "IMAGE_SIZE_INVALID" });
    await expect(service.addImage(truncated)).rejects.toMatchObject({ code: "IMAGE_CONTENT_INVALID" });
    await expect(service.addImage(unsupported)).rejects.toMatchObject({ code: "IMAGE_TYPE_UNSUPPORTED" });
  });

  it("revalidates a selected image immediately before turn/start", async () => {
    const root = await temporaryDirectory();
    const imagePath = path.join(root, "pixel.png");
    const bytes = validPng();
    await writeFile(imagePath, bytes);
    const service = new AttachmentService();
    const attachment = await service.addImage(imagePath);
    await writeFile(imagePath, Buffer.alloc(bytes.length, 0));
    await expect(service.resolve([attachment.id])).rejects.toMatchObject({ code: "IMAGE_ATTACHMENT_CHANGED" });
  });
});

describe("Phase 2 approval routing", () => {
  function fixture() {
    const respondToServerRequest = vi.fn();
    const rejectServerRequest = vi.fn();
    const onUnsupported = vi.fn();
    const service = new CodexApprovalService(
      { respondToServerRequest, rejectServerRequest },
      { onUnsupported, timeoutMs: 60_000 },
    );
    return { service, respondToServerRequest, rejectServerRequest, onUnsupported };
  }

  it.each(["accept", "acceptForSession", "decline"] as const)("returns exact command decision %s", (decision) => {
    const { service, respondToServerRequest } = fixture();
    service.handle({ id: 7, method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "npm test", cwd: "C:\\work",
    } });
    const approval = service.list()[0]!;
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision }, "thread-1");
    expect(respondToServerRequest).toHaveBeenCalledWith(7, { decision });
    expect(service.list()).toEqual([]);
  });

  it.each(["accept", "acceptForSession", "decline"] as const)("returns exact file decision %s", (decision) => {
    const { service, respondToServerRequest } = fixture();
    service.handle({ id: "file-approval", method: "item/fileChange/requestApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "file-1", reason: "write outside root",
    } });
    const approval = service.list()[0]!;
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision }, "thread-1");
    expect(respondToServerRequest).toHaveBeenCalledWith("file-approval", { decision });
  });

  it("isolates approvals by thread and prevents duplicate responses", () => {
    const { service, respondToServerRequest } = fixture();
    service.handle({ id: 1, method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1",
    } });
    const approval = service.list()[0]!;
    expect(() => service.respond({ approvalId: approval.id, threadId: "thread-2", decision: "accept" }, "thread-2"))
      .toThrow("Onay isteği bu sohbete ait değil");
    expect(respondToServerRequest).not.toHaveBeenCalled();
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "decline" }, "thread-1");
    expect(() => service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "accept" }, "thread-1"))
      .toThrow("artık geçerli değil");
  });

  it("never auto-approves unknown server requests and records method metadata only", () => {
    const { service, rejectServerRequest, respondToServerRequest, onUnsupported } = fixture();
    service.handle({ id: 9, method: "future/dangerousApproval", params: { secret: "must not escape" } });
    expect(rejectServerRequest).toHaveBeenCalledWith(9, -32601, expect.any(String));
    expect(respondToServerRequest).not.toHaveBeenCalled();
    expect(onUnsupported).toHaveBeenCalledWith("future/dangerousApproval");
    expect(JSON.stringify(onUnsupported.mock.calls)).not.toContain("must not escape");
  });

  it("cleans stale approvals on server resolution, interruption, and Codex exit", () => {
    const { service, respondToServerRequest } = fixture();
    service.handle({ id: 10, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "f1" } });
    service.resolveRequest(10);
    expect(service.list()).toEqual([]);
    service.handle({ id: 11, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "f2" } });
    service.clearTurn("thread-1", "turn-1", true);
    expect(respondToServerRequest).toHaveBeenLastCalledWith(11, { decision: "cancel" });
    service.handle({ id: 12, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-2", itemId: "f3" } });
    service.clear(false);
    expect(service.list()).toEqual([]);
    expect(respondToServerRequest).not.toHaveBeenCalledWith(12, expect.anything());
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evren-phase2-"));
  directories.push(directory);
  return directory;
}

function validPng(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
}

function validJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00,
    0xff, 0xd9,
  ]);
}

function validWebp(): Buffer {
  const bytes = Buffer.alloc(26);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(18, 4);
  bytes.write("WEBPVP8L", 8, "ascii");
  bytes.writeUInt32LE(5, 16);
  bytes[20] = 0x2f;
  return bytes;
}
