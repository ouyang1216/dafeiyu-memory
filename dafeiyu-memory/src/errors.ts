/**
 * Errors that are safe to return to an MCP caller without exposing storage
 * implementation details.
 */
export class MemoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryInputError";
  }
}

export class MemoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryNotFoundError";
  }
}
