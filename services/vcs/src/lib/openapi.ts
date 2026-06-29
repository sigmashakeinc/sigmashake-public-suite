/**
 * OpenAPI 3.1 description of the VCS public API, built per-request so the
 * `servers` URL reflects the actual origin (production vs. wrangler dev).
 * Served as JSON at /api/public/openapi.json; rendered by /api/public/docs.
 */

const twitchLoginParam = {
  name: "twitch_login",
  in: "path",
  required: true,
  description: "The chatter's Twitch login (lowercase username, [a-z0-9_]).",
  schema: { type: "string", pattern: "^[a-z0-9_]{1,25}$" },
} as const;

function jsonResponse(description: string, schema: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  };
}

const commonErrors = {
  "401": jsonResponse("Missing or invalid API key.", "Error"),
  "403": jsonResponse("API key lacks the required scope.", "Error"),
  "503": jsonResponse("Streamer bridge offline, or the API is not configured.", "Error"),
};

const badLogin = { "400": jsonResponse("Malformed Twitch login.", "Error") };

export function buildOpenApiSpec(origin: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "SigmaShake VCS Public API",
      version: "1.0.0",
      description:
        "Read-only access to Vibe Coder Sim character data, keyed by Twitch login.\n\n" +
        "Authenticate every request with a bearer API key: `Authorization: Bearer sk_vcs_…`. " +
        "Keys are server-side secrets — do not embed them in browser/client code.\n\n" +
        "Data endpoints proxy the live streamer bridge; when the streamer is offline they " +
        'return `503` with `error: "bridge_offline"`.',
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/public/v1/character/{twitch_login}": {
        get: {
          summary: "Get a chatter's character / cosmetic loadout",
          operationId: "getCharacter",
          parameters: [twitchLoginParam],
          responses: {
            "200": jsonResponse("The chatter's character payload.", "CharacterResponse"),
            ...badLogin,
            ...commonErrors,
          },
        },
      },
      "/api/public/v1/character/{twitch_login}/combat-gear": {
        get: {
          summary: "Get a chatter's MMO sigma combat loadout",
          operationId: "getCombatGear",
          parameters: [twitchLoginParam],
          responses: {
            "200": jsonResponse("The chatter's combat-gear payload.", "GenericResponse"),
            ...badLogin,
            ...commonErrors,
          },
        },
      },
      "/api/public/v1/catalog": {
        get: {
          summary: "Get the global cosmetic item catalog",
          operationId: "getCatalog",
          responses: {
            "200": jsonResponse(
              "The full item catalog (identical for every caller).",
              "CatalogResponse",
            ),
            ...commonErrors,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "sk_vcs_*" },
      },
      schemas: {
        CharacterResponse: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
            loadout: {
              type: "object",
              additionalProperties: true,
              description: "Cosmetic loadout (slot → item key). Schema owned by chat-elixir.",
            },
          },
        },
        CatalogResponse: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
            items: {
              type: "object",
              description: "Catalog items grouped by cosmetic slot.",
              additionalProperties: {
                type: "array",
                items: { $ref: "#/components/schemas/CatalogItem" },
              },
            },
          },
        },
        CatalogItem: {
          type: "object",
          properties: {
            slot: { type: "string" },
            key: { type: "string" },
            rarity: { type: "string" },
            pack: { type: "string" },
            tier_required: { type: ["integer", "null"] },
            cost_xp: { type: "integer" },
          },
        },
        GenericResponse: {
          type: "object",
          required: ["ok"],
          additionalProperties: true,
          properties: { ok: { type: "boolean" } },
        },
        Error: {
          type: "object",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", description: "Machine-readable error code." },
          },
        },
      },
    },
  };
}
