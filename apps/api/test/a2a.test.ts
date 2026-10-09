/** A2A (protocol 1.0, HTTP+JSON): the agent card, and verification over message:send. */
import { NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function setup() {
  h = await createHarness({
    codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
  });
}

const request = (src: string) => ({
  spec: {
    version: 1,
    title: "f",
    request: "Write f() returning 1.",
    vertical: "code",
    criteria: [
      { id: "tests-pass", description: "Tests pass", check: "deterministic", critical: true },
    ],
  },
  inputs: [
    {
      name: "t/a.test.mjs",
      media_type: "text/javascript",
      content: `import test from "node:test";\nimport { f } from "../f.mjs";\ntest("[tests-pass] f", () => { if (f() !== 1) throw new Error("no"); });\n`,
    },
  ],
  deliverable: [{ name: "f.mjs", media_type: "text/javascript", content: src }],
});

const send = (body: unknown, headers: Record<string, string> = { "A2A-Version": "1.0" }) =>
  h.call(h.keys.platformA, "POST", "/a2a/message:send", body, headers);

describe("A2A", () => {
  it("publishes an agent card that describes exactly what's served", async () => {
    await setup();
    const res = await h.call(null, "GET", "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = res.body;
    for (const field of [
      "name",
      "description",
      "supportedInterfaces",
      "version",
      "capabilities",
      "defaultInputModes",
      "defaultOutputModes",
      "skills",
    ]) {
      expect(card[field]).toBeDefined();
    }
    expect(card.supportedInterfaces).toEqual([
      { url: "http://localhost/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ]);
    expect(card.capabilities).toMatchObject({ streaming: false, pushNotifications: false });
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(["verify-deliverable"]);
    expect(card.securitySchemes.proofdesk_api_key.httpAuthSecurityScheme.scheme).toBe("Bearer");
  });

  it("verifies work sent as a data part and returns the verdict as a task artifact", async () => {
    await setup();
    const res = await send({
      message: {
        role: "ROLE_USER",
        messageId: "m-1",
        contextId: "ctx-42",
        parts: [{ mediaType: "application/json", data: request("export const f = () => 1;") }],
      },
    });
    expect(res.status).toBe(200);
    const task = res.body.task;
    expect(task).toMatchObject({
      contextId: "ctx-42",
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [
        {
          name: "verdict",
          parts: [
            {
              mediaType: "application/json",
              data: expect.objectContaining({
                passed: true,
                outcome: { kind: "release" },
                criteria: [expect.objectContaining({ id: "tests-pass", verdict: "pass" })],
              }),
            },
          ],
        },
      ],
    });
    // It's a Verify API job underneath: same id, retrievable either way.
    const again = await h.call(h.keys.platformA, "GET", `/a2a/tasks/${task.id}`);
    expect(again.body.status.state).toBe("TASK_STATE_COMPLETED");
    expect(
      (await h.call(h.keys.platformA, "GET", `/v1/verifications/${task.id}`)).body.outcome,
    ).toEqual({
      kind: "release",
    });
    expect((await h.call(h.keys.platformB, "GET", `/a2a/tasks/${task.id}`)).status).toBe(404);

    const failing = (
      await send({
        message: {
          role: "ROLE_USER",
          messageId: "m-2",
          parts: [{ data: request("export const f = () => 2;") }],
        },
      })
    ).body.task;
    expect(failing.artifacts[0].parts[0].data).toMatchObject({
      passed: false,
      outcome: { kind: "refund" },
    });
  });

  it("answers with instructions when the message has no usable data part", async () => {
    await setup();
    const res = await send({
      message: { role: "ROLE_USER", messageId: "m-3", parts: [{ text: "please check my code" }] },
    });
    expect(res.body.message.role).toBe("ROLE_AGENT");
    expect(res.body.message.parts[0].text).toContain("data part");
    expect((await h.call(h.keys.platformA, "GET", "/v1/verifications")).body.data).toEqual([]);
  });

  it("requires an API key and a supported protocol version", async () => {
    await setup();
    expect((await h.call(null, "POST", "/a2a/message:send", { message: {} })).status).toBe(401);
    const old = await send({ message: { messageId: "x", parts: [] } }, { "A2A-Version": "0.1" });
    expect(old.status).toBe(400);
    expect(old.body.error.code).toBe("version_not_supported");
  });
});
