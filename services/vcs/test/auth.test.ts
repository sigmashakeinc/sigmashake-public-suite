// test/auth.test.ts — resolveViewer turns a session_id cookie into the
// ViewerContext that every /api/v1/vcs/* mutation depends on. The function
// MUST never throw — KV outages, secret rotation, and malformed sessions
// all degrade to null so the caller returns 401, never 500.

import { describe, expect, test } from "bun:test";
import { resolveViewer } from "../src/lib/auth";
import type { VcsSession } from "../src/lib/session";

interface MockEnvOpts {
  session?: VcsSession | null;
  encryptionKey?: string;
  throwOnKvGet?: boolean;
}

class FakeKv {
  constructor(
    private session: VcsSession | null,
    private shouldThrow: boolean,
  ) {}
  async get<T = unknown>(_key: string, _typeOrOpts?: unknown): Promise<T | null> {
    if (this.shouldThrow) throw new Error("kv down");
    return (this.session ?? null) as T | null;
  }
}

/** Build a Hono-shaped Context with just the surface resolveViewer touches. */
function makeContext(cookieValue: string | undefined, opts: MockEnvOpts) {
  const headers = new Headers();
  if (cookieValue !== undefined) headers.set("Cookie", `session_id=${cookieValue}`);

  return {
    req: {
      raw: new Request("https://vcs.example/api/v1/vcs/me", { headers }),
      header(name: string): string | undefined {
        return headers.get(name) ?? undefined;
      },
    },
    env: {
      SESSIONS: new FakeKv(
        opts.session ?? null,
        opts.throwOnKvGet ?? false,
      ) as unknown as KVNamespace,
      ENCRYPTION_KEY: opts.encryptionKey
        ? {
            async get() {
              return opts.encryptionKey!;
            },
          }
        : undefined,
    },
  } as unknown as Parameters<typeof resolveViewer>[0];
}

const TWITCH_SESSION: VcsSession = {
  userId: "twitch:99887766",
  login: "alice",
  avatar: "https://example/a.png",
  authType: "twitch",
  twitchLogin: "alice",
};

describe("resolveViewer", () => {
  test("returns null when cookie header is absent", async () => {
    const got = await resolveViewer(makeContext(undefined, { session: TWITCH_SESSION }));
    expect(got).toBeNull();
  });

  test("returns null when session is not in KV", async () => {
    const got = await resolveViewer(makeContext("abc", { session: null }));
    expect(got).toBeNull();
  });

  test("returns ViewerContext on a valid twitch session (generic + back-compat fields)", async () => {
    const got = await resolveViewer(makeContext("abc", { session: TWITCH_SESSION }));
    expect(got).toEqual({
      source: "twitch",
      login: "alice",
      user_id: "99887766",
      display: "alice",
      twitch_user_id: "99887766",
      twitch_login: "alice",
      twitch_display: "alice",
    });
  });

  test("twitch generic and twitch_* values are identical", async () => {
    const got = await resolveViewer(makeContext("abc", { session: TWITCH_SESSION }));
    expect(got?.login).toBe(got?.twitch_login);
    expect(got?.user_id).toBe(got?.twitch_user_id);
    expect(got?.display).toBe(got?.twitch_display);
  });

  test('strips the "twitch:" prefix from userId', async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, userId: "twitch:42" },
      }),
    );
    expect(got?.user_id).toBe("42");
    expect(got?.twitch_user_id).toBe("42");
  });

  test("accepts a userId without the twitch: prefix (legacy path)", async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, userId: "12345" },
      }),
    );
    expect(got?.user_id).toBe("12345");
    expect(got?.twitch_user_id).toBe("12345");
  });

  test("returns null when userId is missing entirely", async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, userId: "" },
      }),
    );
    expect(got).toBeNull();
  });

  test('returns null when userId is just "twitch:" (no id segment)', async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, userId: "twitch:" },
      }),
    );
    expect(got).toBeNull();
  });

  test("returns null for a non-string userId", async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        // userId is a number — guard kicks in.
        session: { ...TWITCH_SESSION, userId: 42 as unknown as string },
      }),
    );
    expect(got).toBeNull();
  });

  test("falls back to .login when twitchLogin is absent and authType is twitch", async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, twitchLogin: undefined },
      }),
    );
    expect(got?.source).toBe("twitch");
    expect(got?.login).toBe("alice");
    expect(got?.twitch_login).toBe("alice");
  });

  test("returns null when authType is github and twitchLogin is absent (unsupported provider)", async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, authType: "github", twitchLogin: undefined },
      }),
    );
    expect(got).toBeNull();
  });

  test("treats a legacy authType-less session carrying twitchLogin as twitch", async () => {
    // A pre-multiauth session may have no authType but a populated twitchLogin —
    // resolve it as twitch and trust the session-derived login.
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, authType: undefined, twitchLogin: "alice" },
      }),
    );
    expect(got?.source).toBe("twitch");
    expect(got?.login).toBe("alice");
    expect(got?.twitch_login).toBe("alice");
  });

  test("returns null when login string is empty", async () => {
    const got = await resolveViewer(
      makeContext("abc", {
        session: { ...TWITCH_SESSION, twitchLogin: "", login: "" },
      }),
    );
    expect(got).toBeNull();
  });

  test("degrades to null when KV throws (no 500 leaks to viewer)", async () => {
    const got = await resolveViewer(makeContext("abc", { throwOnKvGet: true }));
    expect(got).toBeNull();
  });

  // ── Multi-source (kick / google) ────────────────────────────────────────

  const KICK_SESSION: VcsSession = {
    userId: "kick:5551212",
    login: "bobstream",
    avatar: "",
    authType: "kick",
  };

  const GOOGLE_SESSION: VcsSession = {
    userId: "google:108273645",
    login: "carol@example.com",
    avatar: "",
    authType: "google",
  };

  test("returns a kick ViewerContext for an authType:kick session", async () => {
    const got = await resolveViewer(makeContext("abc", { session: KICK_SESSION }));
    expect(got).toEqual({
      source: "kick",
      login: "bobstream",
      user_id: "5551212",
      display: "bobstream",
      twitch_user_id: "5551212",
      twitch_login: "bobstream",
      twitch_display: "bobstream",
    });
  });

  test('strips the "kick:" prefix from a kick userId', async () => {
    const got = await resolveViewer(
      makeContext("abc", { session: { ...KICK_SESSION, userId: "kick:42" } }),
    );
    expect(got?.source).toBe("kick");
    expect(got?.user_id).toBe("42");
  });

  test("lowercases the kick slug login", async () => {
    const got = await resolveViewer(
      makeContext("abc", { session: { ...KICK_SESSION, login: "BobStream" } }),
    );
    expect(got?.login).toBe("bobstream");
  });

  test("returns a google ViewerContext (login is the lowercased email)", async () => {
    const got = await resolveViewer(
      makeContext("abc", { session: { ...GOOGLE_SESSION, login: "Carol@Example.com" } }),
    );
    expect(got).toEqual({
      source: "google",
      login: "carol@example.com",
      user_id: "108273645",
      display: "carol@example.com",
      twitch_user_id: "108273645",
      twitch_login: "carol@example.com",
      twitch_display: "carol@example.com",
    });
  });

  test('strips the "google:" prefix from a google userId', async () => {
    const got = await resolveViewer(
      makeContext("abc", { session: { ...GOOGLE_SESSION, userId: "google:7" } }),
    );
    expect(got?.source).toBe("google");
    expect(got?.user_id).toBe("7");
  });

  test("returns null for a kick session missing its login", async () => {
    const got = await resolveViewer(
      makeContext("abc", { session: { ...KICK_SESSION, login: "" } }),
    );
    expect(got).toBeNull();
  });

  test("returns null for a kick session missing its id", async () => {
    const got = await resolveViewer(
      makeContext("abc", { session: { ...KICK_SESSION, userId: "" } }),
    );
    expect(got).toBeNull();
  });

  // ── Unsupported providers are rejected ──────────────────────────────────

  for (const authType of ["saml", "oidc", "github", "microsoft", "apple"] as const) {
    test(`returns null for an unsupported provider session (authType:${authType})`, async () => {
      const got = await resolveViewer(
        makeContext("abc", {
          session: {
            userId: `${authType}:1`,
            login: "someone",
            avatar: "",
            // microsoft/apple aren't in the VcsSession union but resolveViewer
            // must still reject any authType it doesn't explicitly accept.
            authType: authType as unknown as VcsSession["authType"],
          },
        }),
      );
      expect(got).toBeNull();
    });
  }
});
