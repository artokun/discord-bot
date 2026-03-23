/**
 * NDJSON line buffer — handles partial lines across stream reads.
 * Each call to feed() returns complete parsed JSON objects.
 */
export class NdjsonParser {
  private buffer = "";

  feed(chunk: string): Array<Record<string, unknown>> {
    this.buffer += chunk;
    const results: Array<Record<string, unknown>> = [];
    const lines = this.buffer.split("\n");
    // Keep the last (potentially incomplete) segment
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }
    return results;
  }

  /** Flush any remaining buffer (call on stream end) */
  flush(): Array<Record<string, unknown>> {
    if (!this.buffer.trim()) return [];
    try {
      return [JSON.parse(this.buffer.trim())];
    } catch {
      return [];
    } finally {
      this.buffer = "";
    }
  }
}
