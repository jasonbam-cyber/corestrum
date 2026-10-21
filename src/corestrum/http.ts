/** Limit streams before decoding; never buffer an unbounded credential payload. */
export async function readBody(
  input: Request | Response,
  limit: number,
): Promise<string> {
  if (Number(input.headers.get("content-length")) > limit)
    throw new Error("BODY_TOO_LARGE");
  const reader = input.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("BODY_TOO_LARGE");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    await reader.cancel();
    throw error;
  }
}
