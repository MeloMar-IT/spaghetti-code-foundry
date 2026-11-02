import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHUNK = 64_000;

/**
 * Visits the lines of a file from the last to the first, one chunk at a time; stops when `visit` returns false.
 * The line cut at the start of a chunk is kept as bytes and decoded only when whole: a chunk may end inside a
 * multi-byte character such as "→". Throws when the file cannot be opened.
 */
export function readBack(path: string, visit: (line: string) => boolean, chunkSize = CHUNK): void {
  const fd = openSync(path, "r");
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (pos > 0) {
      const size = Math.min(chunkSize, pos);
      pos -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, pos);
      let buf = Buffer.concat([chunk, carry]);
      if (pos > 0) {
        // the first line may be cut at the start of the chunk: it is read again with the next one
        const cut = buf.indexOf(10);
        if (cut < 0) {
          carry = buf;
          continue;
        }
        carry = buf.subarray(0, cut);
        buf = buf.subarray(cut + 1);
      } else carry = Buffer.alloc(0);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) if (!visit(lines[i]!)) return;
    }
  } finally {
    closeSync(fd);
  }
}
