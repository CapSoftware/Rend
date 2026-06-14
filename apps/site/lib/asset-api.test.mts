import assert from "node:assert/strict";
import test from "node:test";
import {
  UploadTooLargeError,
  limitedRequestBody,
  requestContentLengthWithinLimit,
  supportedUploadContentType,
} from "./asset-api.ts";

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

test("upload content type allowlist accepts raw video bodies only", () => {
  assert.equal(supportedUploadContentType("video/mp4"), true);
  assert.equal(supportedUploadContentType("video/quicktime; charset=binary"), true);
  assert.equal(supportedUploadContentType("application/octet-stream"), true);
  assert.equal(supportedUploadContentType("multipart/form-data; boundary=x"), false);
  assert.equal(supportedUploadContentType("application/json"), false);
  assert.equal(supportedUploadContentType(null), false);
});

test("content-length validation rejects invalid and oversized uploads", () => {
  assert.deepEqual(requestContentLengthWithinLimit(null, 10), { ok: true });
  assert.deepEqual(requestContentLengthWithinLimit("7", 10), { ok: true, bytes: 7 });
  assert.deepEqual(requestContentLengthWithinLimit("nope", 10), {
    ok: false,
    status: 400,
    error: "invalid_content_length",
  });
  assert.deepEqual(requestContentLengthWithinLimit("11", 10), {
    ok: false,
    status: 413,
    error: "upload_too_large",
  });
});

test("limited request body streams chunks and errors after max bytes", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  });

  await assert.rejects(readAll(limitedRequestBody(body, 5)), UploadTooLargeError);
});

test("limited request body passes through bodies within the limit", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });

  assert.deepEqual(await readAll(limitedRequestBody(body, 5)), Buffer.from([1, 2, 3]));
});
