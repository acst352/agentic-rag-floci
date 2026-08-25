import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock is hoisted; use vi.hoisted for the shared send mock so the
// factory closure can reference it safely.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(),
  CreateTableCommand: vi.fn(),
  DescribeTableCommand: vi.fn(),
  ResourceNotFoundException: class extends Error {},
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: sendMock })) },
  PutCommand: vi.fn(),
  GetCommand: vi.fn(),
}));

import { getSession, saveSession } from "../../src/session/store";

describe("session store — H-03 authorization (v1.3)", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("getSession returns null when userId is empty (defensive)", async () => {
    sendMock.mockResolvedValueOnce({ Item: { session_id: "x", user_id: "alice" } });
    const result = await getSession("x", "");
    expect(result).toBeNull();
    // No DDB call should have been made — early return.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("getSession returns the session when the caller is the owner", async () => {
    sendMock.mockResolvedValueOnce({
      Item: {
        session_id: "abc",
        user_id: "alice",
        created_at: "2026-01-01T00:00:00Z",
        last_query: "q",
        last_response: "r",
        iterations: 1,
      },
    });
    const result = await getSession("abc", "alice");
    expect(result).not.toBeNull();
    expect(result?.user_id).toBe("alice");
  });

  it("getSession returns null when the session belongs to another user", async () => {
    sendMock.mockResolvedValueOnce({
      Item: {
        session_id: "abc",
        user_id: "alice",
        created_at: "2026-01-01T00:00:00Z",
        last_query: "q",
        last_response: "r",
        iterations: 1,
      },
    });
    const result = await getSession("abc", "bob");
    expect(result).toBeNull();
  });

  it("getSession returns null when the session does not exist", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    const result = await getSession("missing", "alice");
    expect(result).toBeNull();
  });

  it("saveSession accepts SessionRecord with user_id", async () => {
    sendMock.mockResolvedValueOnce({});
    await saveSession({
      session_id: "s1",
      user_id: "alice",
      created_at: "2026-01-01T00:00:00Z",
      last_query: "q",
      last_response: "r",
      iterations: 1,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});