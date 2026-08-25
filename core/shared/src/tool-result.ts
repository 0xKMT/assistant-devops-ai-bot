/** Converts a typed result into OpenClaw's text-plus-details tool envelope. */
import type { ToolTextResult } from "./types.js";

export function toolResult<T>(value: T): ToolTextResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  };
}
