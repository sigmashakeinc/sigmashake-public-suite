import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

type MockNode = {
  tagName: string;
  parentNode: MockNode | null;
  children: MockNode[];
  className: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  textContent: string;
  src?: string;
  alt?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  onerror?: (() => void) | null;
  onload?: (() => void) | null;
  appendChild: (node: MockNode) => MockNode;
  replaceChild: (newNode: MockNode, oldNode: MockNode) => MockNode;
  removeChild: (node: MockNode) => void;
  remove: () => void;
};

type MockDocument = {
  createElement: (tagName: string) => MockNode;
  createTextNode: (value: string) => MockNode;
};

type ChatBubbleHelpers = {
  emoteUrl: (provider: string, id: string, big?: boolean, metadataUrl?: string) => string | null;
  buildInlineEmoteImg: (seg: {
    type?: string;
    provider?: string;
    id?: string;
    url?: string;
    code?: string;
    shortcut?: string;
    text?: string;
  }) => MockNode | null;
  appendSegments: (parent: MockNode, segments: unknown[], fallbackText: string) => boolean;
  isSingleBaseEmoteOnlyMessage: (segments: unknown[]) => boolean;
};

const CHAT_BUBBLES_HTML = readFileSync(
  join(import.meta.dir, "..", "overlay", "chat-bubbles.html"),
  "utf8",
);
const CHAT_SCRIPT = CHAT_BUBBLES_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!CHAT_SCRIPT) {
  throw new Error("chat-bubbles.html missing inline script block");
}

const BIG_EMOTE_CONSTANTS = CHAT_SCRIPT.match(
  /const BIG_EMOTE_MAX[\s\S]*?const BIG_EMOTE_WIDE_COLUMNS = [^;]+;/,
)?.[0];
if (!BIG_EMOTE_CONSTANTS) {
  throw new Error("chat-bubbles.html missing big-emote constants");
}

const HELPER_SOURCE = `${BIG_EMOTE_CONSTANTS}\n${CHAT_SCRIPT.slice(
  CHAT_SCRIPT.indexOf("const _esc ="),
  CHAT_SCRIPT.indexOf("function roleBadges"),
)}`;

function createMockNode(tagName: string, isText = false): MockNode {
  const node: MockNode = {
    tagName,
    parentNode: null,
    children: isText ? [] : [],
    className: "",
    style: {},
    dataset: {},
    textContent: "",
    appendChild(child: MockNode) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    replaceChild(newNode: MockNode, oldNode: MockNode) {
      const idx = node.children.indexOf(oldNode);
      if (idx === -1) return newNode;
      node.children[idx] = newNode;
      newNode.parentNode = node;
      oldNode.parentNode = null;
      return newNode;
    },
    removeChild(child: MockNode) {
      const idx = node.children.indexOf(child);
      if (idx >= 0) node.children.splice(idx, 1);
      child.parentNode = null;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
  };

  return node;
}

function createMockDocument(): MockDocument {
  return {
    createElement: (tagName: string) => createMockNode(tagName),
    createTextNode: (value: string) => {
      const node = createMockNode("#text", true);
      node.textContent = String(value);
      return node;
    },
  };
}

function loadHelpers(document: MockDocument): ChatBubbleHelpers {
  const factory = new Function(
    "document",
    `${HELPER_SOURCE}\nreturn { emoteUrl, buildInlineEmoteImg, appendSegments, isSingleBaseEmoteOnlyMessage };`,
  ) as (doc: MockDocument) => ChatBubbleHelpers;
  return factory(document);
}

function firstChild(node: MockNode): MockNode | undefined {
  return node.children[0];
}

function hasClass(node: MockNode | undefined, className: string): boolean {
  return String(node?.className || "")
    .split(/\s+/)
    .includes(className);
}

describe("chat-bubbles youtube emote URL handling", () => {
  test("uses a valid YouTube thumbnail URL from segment metadata", () => {
    const doc = createMockDocument();
    const { emoteUrl, buildInlineEmoteImg } = loadHelpers(doc);
    const metadataUrl = "https://yt3.ggpht.com/emotes/test";

    assert.equal(emoteUrl("youtube", "yt-smile", false, metadataUrl), metadataUrl);

    const el = buildInlineEmoteImg({
      provider: "youtube",
      id: "yt-smile",
      url: metadataUrl,
      code: "ytSmile",
    });

    assert.notEqual(el, null);
    assert.equal(el?.dataset.pendingSrc, "/emote/youtube/yt-smile.png");
    const textParent = doc.createElement("span");
    textParent.appendChild(el!);
    el?.onerror?.();
    assert.equal(el?.src, metadataUrl);
  });

  test("uses googleusercontent metadata URL variants for YouTube emotes", () => {
    const doc = createMockDocument();
    const { emoteUrl } = loadHelpers(doc);
    const metadataUrl = "https://cdn0.lh3.googleusercontent.com/emotes/abc";

    assert.equal(emoteUrl("youtube", "yt-smile", false, metadataUrl), metadataUrl);
  });

  test("uses gstatic metadata URL variants for YouTube emotes", () => {
    const doc = createMockDocument();
    const { emoteUrl } = loadHelpers(doc);
    const metadataUrl = "https://fonts.gstatic.com/youtube/img/emote.svg";

    assert.equal(emoteUrl("youtube", "yt-smile", false, metadataUrl), metadataUrl);
  });

  test("falls back to text when youtube metadata URL is rejected", () => {
    const doc = createMockDocument();
    const { buildInlineEmoteImg } = loadHelpers(doc);
    const el = buildInlineEmoteImg({
      provider: "youtube",
      id: "yt-guarded",
      shortcut: ":ytGuard:",
      url: "https://yt3.ggpht.com.example.org/evil",
      text: "fallbackText",
    });

    assert.notEqual(el, null);
    const textParent = doc.createElement("span");
    textParent.appendChild(el!);
    el?.onerror?.();

    const replacement = firstChild(textParent);
    assert.equal(replacement?.tagName, "#text");
    assert.equal(replacement?.textContent, ":ytGuard:");
  });

  test("falls back to id when code/shortcut/text are unavailable", () => {
    const doc = createMockDocument();
    const { buildInlineEmoteImg } = loadHelpers(doc);
    const el = buildInlineEmoteImg({
      provider: "youtube",
      id: "yt-guarded-id-only",
      url: "https://yt3.ggpht.com.example.org/evil",
    });

    assert.notEqual(el, null);
    const textParent = doc.createElement("span");
    textParent.appendChild(el!);
    el?.onerror?.();

    const replacement = firstChild(textParent);
    assert.equal(replacement?.textContent, "yt-guarded-id-only");
  });

  test("rejects non-allowed YouTube hosts and non-HTTPS URLs", () => {
    const doc = createMockDocument();
    const { emoteUrl } = loadHelpers(doc);

    assert.equal(emoteUrl("youtube", "yt-smile", false, "http://yt3.ggpht.com/emote"), null);
    assert.equal(
      emoteUrl("youtube", "yt-smile", false, "https://yt3.ggpht.com.example.org/evil"),
      null,
    );
  });
});

describe("chat-bubbles text and Twitch behavior", () => {
  test("renders text segments as text nodes (DOM-safe)", () => {
    const doc = createMockDocument();
    const { appendSegments } = loadHelpers(doc);
    const parent = doc.createElement("span");

    appendSegments(parent, [{ type: "text", value: "<b>unsafe</b>" }], "fallback");
    const child = firstChild(parent);

    assert.equal(child?.tagName, "#text");
    assert.equal(child?.textContent, "<b>unsafe</b>");
  });

  test("preserves Twitch emote URL behavior", () => {
    const doc = createMockDocument();
    const { emoteUrl, buildInlineEmoteImg } = loadHelpers(doc);

    assert.equal(
      emoteUrl("twitch", "25", false),
      "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
    );
    assert.equal(
      emoteUrl("twitch", "25", true),
      "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0",
    );

    const el = buildInlineEmoteImg({ type: "emote", provider: "twitch", id: "25", code: "Kappa" });
    assert.notEqual(el, null);
    assert.equal(el?.dataset.pendingSrc, "/emote/twitch/25.png");
  });
});

describe("chat-bubbles single-base emote classification", () => {
  test("classifies exactly one base emote as a single-emote message", () => {
    const doc = createMockDocument();
    const { isSingleBaseEmoteOnlyMessage } = loadHelpers(doc);

    assert.equal(
      isSingleBaseEmoteOnlyMessage([
        { type: "emote", provider: "twitch", id: "25", code: "Kappa" },
      ]),
      true,
    );
  });

  test("counts zero-width overlays attached to one base as one base emote", () => {
    const doc = createMockDocument();
    const { isSingleBaseEmoteOnlyMessage } = loadHelpers(doc);

    assert.equal(
      isSingleBaseEmoteOnlyMessage([
        { type: "emote", provider: "twitch", id: "25", code: "Kappa" },
        { type: "emote", provider: "7tv", id: "overlay", code: "Overlay", zeroWidth: true },
      ]),
      true,
    );
  });

  test("does not treat a leading unattached zero-width emote as a single base", () => {
    const doc = createMockDocument();
    const { isSingleBaseEmoteOnlyMessage } = loadHelpers(doc);

    assert.equal(
      isSingleBaseEmoteOnlyMessage([
        { type: "emote", provider: "7tv", id: "overlay", code: "Overlay", zeroWidth: true },
        { type: "emote", provider: "twitch", id: "25", code: "Kappa" },
      ]),
      false,
    );
  });

  test("does not classify two base emotes as a single-emote message", () => {
    const doc = createMockDocument();
    const { isSingleBaseEmoteOnlyMessage } = loadHelpers(doc);

    assert.equal(
      isSingleBaseEmoteOnlyMessage([
        { type: "emote", provider: "twitch", id: "25", code: "Kappa" },
        { type: "emote", provider: "twitch", id: "1902", code: "Keepo" },
      ]),
      false,
    );
  });

  test("does not classify text plus emote as a single-emote message", () => {
    const doc = createMockDocument();
    const { isSingleBaseEmoteOnlyMessage } = loadHelpers(doc);

    assert.equal(
      isSingleBaseEmoteOnlyMessage([
        { type: "text", value: "hello " },
        { type: "emote", provider: "twitch", id: "25", code: "Kappa" },
      ]),
      false,
    );
  });

  test("source wires the appendChat class and single-emote CSS path", () => {
    assert.match(
      CHAT_SCRIPT,
      /if \(emoteOnly && isSingleBaseEmoteOnlyMessage\(segs\)\) li\.classList\.add\("chat-single-emote"\);/,
    );
    assert.match(CHAT_BUBBLES_HTML, /\.chat-line\.chat-single-emote\s*\{/);
    assert.match(
      CHAT_BUBBLES_HTML,
      /\.chat-line\.chat-single-emote\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*0;/,
    );
    assert.match(
      CHAT_BUBBLES_HTML,
      /\.chat-line\.chat-single-emote\s+\.chat-author\s*\{[\s\S]*?display:\s*none;/,
    );
    assert.match(
      CHAT_BUBBLES_HTML,
      /\.chat-line\.chat-single-emote\s+\.chat-emote-grid\s*\{[\s\S]*?justify-content:\s*center;/,
    );
    assert.match(CHAT_SCRIPT, /const CHAT_TEXT_FADE_MS = 36000;/);
    assert.match(CHAT_SCRIPT, /const DEDUP_TTL_MS = CHAT_TEXT_FADE_MS \+ 3000;/);
    assert.match(CHAT_SCRIPT, /const visibleMs = emoteOnly \? CHAT_FADE_MS : CHAT_TEXT_FADE_MS;/);
    assert.match(
      CHAT_SCRIPT,
      /function pruneChatBox\(\) \{[\s\S]*?chat-single-emote[\s\S]*?CHAT_MAX/,
    );
    assert.doesNotMatch(CHAT_SCRIPT, /while \(chatBox\.children\.length > CHAT_MAX\)/);
  });
});

describe("chat-bubbles wide big emotes", () => {
  test("metadata-wide emote-only messages mark the image and stack and reserve three columns", () => {
    const doc = createMockDocument();
    const { appendSegments } = loadHelpers(doc);
    const parent = doc.createElement("span");

    const renderedBigGrid = appendSegments(
      parent,
      [{ type: "emote", provider: "twitch", id: "wide", code: "Wide", width: 360, height: 100 }],
      "",
    );

    assert.equal(renderedBigGrid, true);
    const grid = firstChild(parent);
    const stack = grid?.children[0];
    const img = stack?.children[0];

    assert.equal(grid?.style.gridTemplateColumns, "repeat(3, var(--emote-big))");
    assert.equal(hasClass(grid, "chat-emote-grid-wide"), true);
    assert.equal(hasClass(stack, "chat-emote-big-wide-stack"), true);
    assert.equal(hasClass(img, "chat-emote-big-wide"), true);
  });

  test("base image natural dimensions can classify wide after append", () => {
    const doc = createMockDocument();
    const { appendSegments } = loadHelpers(doc);
    const parent = doc.createElement("span");

    appendSegments(parent, [{ type: "emote", provider: "twitch", id: "late", code: "Late" }], "");

    const grid = firstChild(parent);
    const stack = grid?.children[0];
    const img = stack?.children[0];

    assert.equal(grid?.style.gridTemplateColumns, "repeat(1, var(--emote-big))");
    assert.ok(img);
    img.naturalWidth = 360;
    img.naturalHeight = 100;
    img.onload?.();

    assert.equal(grid?.style.gridTemplateColumns, "repeat(3, var(--emote-big))");
    assert.equal(hasClass(grid, "chat-emote-grid-wide"), true);
    assert.equal(hasClass(stack, "chat-emote-big-wide-stack"), true);
    assert.equal(hasClass(img, "chat-emote-big-wide"), true);
  });

  test("normal square big emotes keep the one-column square path", () => {
    const doc = createMockDocument();
    const { appendSegments } = loadHelpers(doc);
    const parent = doc.createElement("span");

    appendSegments(
      parent,
      [
        {
          type: "emote",
          provider: "twitch",
          id: "square",
          code: "Square",
          width: 140,
          height: 140,
        },
      ],
      "",
    );

    const grid = firstChild(parent);
    const stack = grid?.children[0];
    const img = stack?.children[0];

    assert.equal(grid?.style.gridTemplateColumns, "repeat(1, var(--emote-big))");
    assert.equal(stack?.className, "chat-emote-big-stack");
    assert.equal(img?.className, "chat-emote-big");
  });

  test("zero-width overlay images do not trigger wide classification", () => {
    const doc = createMockDocument();
    const { appendSegments } = loadHelpers(doc);
    const parent = doc.createElement("span");

    appendSegments(
      parent,
      [
        { type: "emote", provider: "twitch", id: "base", code: "Base" },
        { type: "emote", provider: "7tv", id: "overlay", code: "Overlay", zeroWidth: true },
      ],
      "",
    );

    const grid = firstChild(parent);
    const stack = grid?.children[0];
    const baseImg = stack?.children[0];
    const overlayImg = stack?.children[1];

    assert.ok(overlayImg);
    overlayImg.naturalWidth = 360;
    overlayImg.naturalHeight = 100;
    overlayImg.onload?.();

    assert.equal(grid?.style.gridTemplateColumns, "repeat(1, var(--emote-big))");
    assert.equal(hasClass(grid, "chat-emote-grid-wide"), false);
    assert.equal(hasClass(stack, "chat-emote-big-wide-stack"), false);
    assert.equal(hasClass(baseImg, "chat-emote-big-wide"), false);
    assert.equal(hasClass(overlayImg, "chat-emote-big-wide"), false);
  });
});
