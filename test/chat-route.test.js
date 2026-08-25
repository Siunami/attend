import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  beginHostListener,
  chatRoutePaths,
  endHostListener,
  hostListenerPresence,
  readChatRoute,
  registerChatAttachment,
  registerHostAttachment,
  resolveChatRoute,
  safeChatCapability,
  setChatRoute,
  verifyHostTicket,
} from "../src/chat-route.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-chat-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("gpt-oss-20b is the default machine-local route and remote routes stay explicit", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await readChatRoute({ root }), {
    kind: "local",
    model: "gpt-oss-20b",
  });

  assert.deepEqual(
    await registerChatAttachment({ root, sessionId: "session_local" }),
    {
      route: { kind: "local", model: "gpt-oss-20b" },
      ticket: null,
      attachment: null,
    },
  );

  assert.deepEqual(
    await setChatRoute({
      root,
      route: { kind: "detached", adapter: "claude-cli" },
    }),
    { kind: "detached", adapter: "claude-cli" },
  );
  assert.deepEqual(await readChatRoute({ root }), {
    kind: "detached",
    adapter: "claude-cli",
  });
  assert.deepEqual(
    await registerChatAttachment({ root, sessionId: "session_route" }),
    {
      route: { kind: "detached", adapter: "claude-cli" },
      ticket: null,
      attachment: null,
    },
  );
});

test("host registration persists only a digest in private-mode local files", async (t) => {
  const root = await fixture(t);
  const registered = await registerHostAttachment({
    root,
    sessionId: "session_private",
  });
  assert.match(registered.ticket, /^attend_host_v1\.host_[a-f0-9]{16}\./u);
  assert.deepEqual(registered.route, {
    kind: "host",
    attachmentId: registered.attachment.id,
    generation: 1,
  });
  assert.equal(Object.hasOwn(registered.attachment, "ticketDigest"), false);

  const paths = chatRoutePaths(root);
  const attachmentFile = join(
    paths.attachments,
    `${registered.attachment.id}.json`,
  );
  const source = await readFile(attachmentFile, "utf8");
  assert.equal(source.includes(registered.ticket), false);
  assert.equal(source.includes(registered.ticket.split(".").at(-1)), false);
  assert.match(JSON.parse(source).ticketDigest, /^[a-f0-9]{64}$/u);
  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.attachments)).mode & 0o777, 0o700);
  assert.equal((await stat(attachmentFile)).mode & 0o777, 0o600);

  assert.deepEqual(await verifyHostTicket({ root, ticket: registered.ticket }), {
    route: registered.route,
    attachment: registered.attachment,
  });
  const replacement = registered.ticket.endsWith("A") ? "B" : "A";
  await assert.rejects(
    verifyHostTicket({
      root,
      ticket: `${registered.ticket.slice(0, -1)}${replacement}`,
    }),
    { code: "HOST_TICKET_INVALID" },
  );
});

test("attachment expiry is enforced independently from listener presence", async (t) => {
  const root = await fixture(t);
  const now = new Date("2026-08-24T18:00:00.000Z");
  const registered = await registerHostAttachment({
    root,
    sessionId: "session_expiry",
    ttlMs: 1_000,
    now,
  });
  await assert.rejects(
    verifyHostTicket({
      root,
      ticket: registered.ticket,
      now: new Date(now.getTime() + 1_000),
    }),
    { code: "HOST_ATTACHMENT_EXPIRED" },
  );
});

test("route resolution uses the newest live attachment only within its session", async (t) => {
  const root = await fixture(t);
  await setChatRoute({ root, route: { kind: "host" } });
  const base = Date.parse("2026-08-24T18:00:00.000Z");
  const firstA = await registerHostAttachment({
    root,
    sessionId: "session_a",
    ttlMs: 10_000,
    now: new Date(base),
  });
  const onlyB = await registerHostAttachment({
    root,
    sessionId: "session_b",
    ttlMs: 10_000,
    now: new Date(base + 1_000),
  });
  const newestA = await registerHostAttachment({
    root,
    sessionId: "session_a",
    ttlMs: 10_000,
    now: new Date(base + 2_000),
  });

  assert.notDeepEqual(firstA.route, newestA.route);
  assert.deepEqual(
    await resolveChatRoute({
      root,
      sessionId: "session_a",
      now: new Date(base + 3_000),
    }),
    newestA.route,
  );
  assert.deepEqual(
    await resolveChatRoute({
      root,
      sessionId: "session_b",
      now: new Date(base + 3_000),
    }),
    onlyB.route,
  );
  assert.deepEqual(
    await resolveChatRoute({
      root,
      sessionId: "session_a",
      hostRoute: firstA.route,
      requireHostRoute: true,
      now: new Date(base + 3_000),
    }),
    firstA.route,
    "an opened viewer remains bound to its original host attachment",
  );
  assert.equal(
    await resolveChatRoute({
      root,
      sessionId: "session_b",
      hostRoute: firstA.route,
      requireHostRoute: true,
      now: new Date(base + 3_000),
    }),
    null,
  );
  assert.equal(
    await resolveChatRoute({
      root,
      sessionId: "session_a",
      requireHostRoute: true,
      now: new Date(base + 3_000),
    }),
    null,
  );
  assert.equal(
    await resolveChatRoute({
      root,
      sessionId: "session_missing",
      now: new Date(base + 3_000),
    }),
    null,
  );
  assert.equal(
    await resolveChatRoute({
      root,
      sessionId: "session_a",
      now: new Date(base + 13_000),
    }),
    null,
  );

  await setChatRoute({
    root,
    route: { kind: "detached", adapter: "codex-cli" },
  });
  assert.deepEqual(
    await resolveChatRoute({
      root,
      sessionId: "session_missing",
      now: new Date(base + 13_000),
    }),
    { kind: "detached", adapter: "codex-cli" },
  );
});

test("listener presence is a safe, revocable projection", async (t) => {
  const root = await fixture(t);
  const registered = await registerHostAttachment({
    root,
    sessionId: "session_listener",
  });
  assert.deepEqual(
    await hostListenerPresence({ root, route: registered.route }),
    { present: false },
  );

  const listener = await beginHostListener({
    root,
    ticket: registered.ticket,
    waitExpiresAt: new Date(Date.now() + 2_000),
  });
  assert.deepEqual(
    await hostListenerPresence({ root, route: registered.route }),
    { present: true },
  );
  const capability = await safeChatCapability({
    root,
    route: registered.route,
  });
  assert.deepEqual(capability, {
    kind: "host",
    label: "Agent that opened this view",
    availability: "listening",
    listenerPresent: true,
    listenerState: "waiting",
    disclosure:
      "Selected evidence will be returned to the coding agent that opened this view.",
  });
  assert.equal(JSON.stringify(capability).includes(registered.ticket), false);
  assert.equal(JSON.stringify(capability).includes(registered.attachment.id), false);

  await endHostListener({ root, listener });
  assert.deepEqual(
    await hostListenerPresence({ root, route: registered.route }),
    { present: false },
  );
});
