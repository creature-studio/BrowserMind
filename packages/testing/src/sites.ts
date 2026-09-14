/**
 * Fake chat sites.
 *
 * Each fixture mirrors the DOM shape that the corresponding plugin selector
 * pack expects (composer kind, send button, streaming indicator, message
 * bubbles). They are the reason the whole runtime — MCP, workers, plugins,
 * streaming detection — can be verified in CI without launching Chrome.
 *
 * ⚠️ When a real website changes its markup, update the plugin's `selectors.ts`
 * and this fixture together: that pair is the plugin's entire contract.
 */

export interface SiteHooks {
  /** Message composer (textarea/input or contenteditable). */
  composer: string;
  /** Send button. */
  send: string;
  /** Stop button — visible only while generating on most sites. */
  stop?: string;
  /** Extra "generating…" indicator toggled with the `hidden` attribute. */
  streaming?: string;
  /** CSS class added to the newest answer while it streams (ChatGPT style). */
  streamingClass?: string;
  newChat?: string;
  /** Container the site appends messages to. */
  messages: string;
  /** Login/quota wall, hidden by default. */
  loginWall?: string;
  fileInput?: string;
  attach?: string;
}

export interface FakeSiteTemplate {
  provider: string;
  url: string;
  html: string;
  hooks: SiteHooks;
  composerKind: 'textarea' | 'contenteditable';
  /** HTML injected for a new answer bubble. `{{{text}}}` is replaced by escaped text. */
  assistantBubble: string;
  /** Optional: clicking the assistant bubble region is a no-op marker for user turns. */
  userBubble: string;
  /** Where `{{{text}}}` lands inside the assistant bubble (defaults to the bubble root). */
  textTarget?: string;
}

const MOCK_HTML = `
<div class="mock-root">
  <div id="login-wall" class="login-wall" hidden>Sign in to the mock provider</div>
  <div id="messages" class="messages">
    <div class="message user"><div class="bubble user-bubble">Hello</div></div>
    <div class="message assistant"><div class="bubble mock-markdown">Mock provider ready.</div></div>
  </div>
  <div class="composer">
    <textarea id="prompt-input" class="mock-input" placeholder="Ask the mock AI"></textarea>
    <button id="attach" type="button" aria-label="Attach file">Attach</button>
    <button id="send-button" type="button" aria-label="Send message">Send</button>
    <button id="stop-button" class="stop-button" type="button" hidden>Stop</button>
    <span id="generating" class="generating" hidden>generating…</span>
    <button id="new-chat" type="button">New chat</button>
    <input id="file-input" class="file-input" type="file" hidden />
  </div>
</div>`;

const DEEPSEEK_HTML = `
<div class="ds-layout">
  <div class="ds-login-modal" hidden>Log in to DeepSeek</div>
  <div id="chat-container" class="ds-chat-container">
    <div class="ds-message ds-message-assistant" data-role="assistant">
      <div class="ds-markdown">Hi, I'm DeepSeek.</div>
    </div>
  </div>
  <div class="ds-composer">
    <textarea id="chat-input" class="ds-textarea" placeholder="Message DeepSeek"></textarea>
    <div class="ds-send-button" role="button" aria-label="Send" aria-disabled="false">send</div>
    <div class="ds-stop-button" role="button" aria-label="Stop generating" hidden>stop</div>
    <div class="ds-generating" hidden>generating…</div>
    <div class="ds-file-input-wrap">
      <input type="file" class="ds-file-input" hidden />
    </div>
    <div class="ds-new-chat" role="button">New chat</div>
    <button class="ds-deep-think" role="switch" aria-checked="false">DeepThink</button>
  </div>
</div>`;

const CHATGPT_HTML = `
<main class="chatgpt-app">
  <div id="login-wall" class="login-wall" hidden>Log in to ChatGPT</div>
  <div id="thread" class="thread">
    <article data-message-author-role="assistant">
      <div class="markdown">ChatGPT is ready.</div>
    </article>
  </div>
  <form class="composer" onsubmit="return false">
    <div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox" aria-label="Message ChatGPT"></div>
    <button data-testid="send-button" type="button" aria-label="Send prompt">Send</button>
    <button data-testid="stop-button" type="button" aria-label="Stop streaming" hidden>Stop</button>
    <input data-testid="file-input" type="file" hidden />
  </form>
</main>`;

const CLAUDE_HTML = `
<div class="claude-app">
  <div class="login-required" hidden>Sign in to Claude</div>
  <div id="conversation" class="conversation">
    <div class="font-claude-message"><div class="markdown">Claude is ready to help.</div></div>
  </div>
  <fieldset class="composer">
    <div class="ProseMirror" id="claude-composer" contenteditable="true" role="textbox" data-placeholder="How can I help you today?"></div>
    <button aria-label="Send Message" type="button">Send</button>
    <button aria-label="Stop response" class="stop-button" type="button" hidden>Stop</button>
    <button aria-label="Start new chat" class="new-chat" type="button">New chat</button>
    <input class="file-upload" type="file" hidden />
  </fieldset>
</div>`;

const GEMINI_HTML = `
<div class="gemini-app">
  <div class="sign-in-wall" hidden>Sign in to Google</div>
  <div id="conversation-container" class="conversation-container">
    <model-response class="model-response">
      <message-content><div class="markdown">Gemini here. How can I help?</div></message-content>
    </model-response>
  </div>
  <rich-textarea class="input-area">
    <div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div>
  </rich-textarea>
  <button class="send-button" aria-label="Send message" type="button">Send</button>
  <button class="stop-button" aria-label="Stop response" type="button" hidden>Stop</button>
  <button class="new-chat-button" type="button">New chat</button>
  <input class="file-input" type="file" hidden />
  <button class="upload-button" aria-label="Add files" type="button">attach</button>
</div>`;

const GROK_HTML = `
<div class="grok-app">
  <div id="login-wall" hidden>Sign in to Grok</div>
  <div id="chat-messages" class="chat-messages">
    <div class="message-bubble assistant"><div class="response-content-markdown">Grok reporting for duty.</div></div>
  </div>
  <div class="composer">
    <textarea id="query-input" aria-label="Ask Grok anything" placeholder="What do you want to know?"></textarea>
    <button type="submit" class="submit-button" aria-label="Submit">Submit</button>
    <button class="stop-button" aria-label="Stop model response" hidden>Stop</button>
    <button class="new-chat-button" type="button">New chat</button>
    <input class="file-input" type="file" hidden />
  </div>
</div>`;

export const SITE_TEMPLATES: Record<string, FakeSiteTemplate> = {
  mock: {
    provider: 'mock',
    url: 'https://mock.browsermind.local/chat',
    html: MOCK_HTML,
    composerKind: 'textarea',
    hooks: {
      composer: '#prompt-input',
      send: '#send-button',
      stop: '#stop-button',
      streaming: '#generating',
      newChat: '#new-chat',
      messages: '#messages',
      loginWall: '#login-wall',
      fileInput: '#file-input',
      attach: '#attach',
    },
    assistantBubble: '<div class="message assistant"><div class="bubble mock-markdown">{{{text}}}</div></div>',
    userBubble: '<div class="message user"><div class="bubble user-bubble">{{{text}}}</div></div>',
  },
  deepseek: {
    provider: 'deepseek',
    url: 'https://chat.deepseek.com/a/chat/s/mock',
    html: DEEPSEEK_HTML,
    composerKind: 'textarea',
    hooks: {
      composer: '#chat-input',
      send: '.ds-send-button',
      stop: '.ds-stop-button',
      streaming: '.ds-generating',
      newChat: '.ds-new-chat',
      messages: '#chat-container',
      loginWall: '.ds-login-modal',
      fileInput: '.ds-file-input',
    },
    assistantBubble:
      '<div class="ds-message ds-message-assistant" data-role="assistant"><div class="ds-markdown">{{{text}}}</div></div>',
    userBubble:
      '<div class="ds-message ds-message-user" data-role="user"><div class="ds-markdown ds-user-content">{{{text}}}</div></div>',
  },
  chatgpt: {
    provider: 'chatgpt',
    url: 'https://chatgpt.com/c/mock-conversation',
    html: CHATGPT_HTML,
    composerKind: 'contenteditable',
    hooks: {
      composer: '#prompt-textarea',
      send: 'button[data-testid="send-button"]',
      stop: 'button[data-testid="stop-button"]',
      streamingClass: 'result-streaming',
      newChat: 'a[data-testid="new-chat-button"], button[data-testid="new-chat-button"]',
      messages: '#thread',
      loginWall: '#login-wall',
      fileInput: 'input[data-testid="file-input"]',
    },
    assistantBubble:
      '<article data-message-author-role="assistant" data-message-id="{{{id}}}"><div class="markdown">{{{text}}}</div></article>',
    userBubble:
      '<article data-message-author-role="user"><div class="whitespace-pre-wrap">{{{text}}}</div></article>',
  },
  claude: {
    provider: 'claude',
    url: 'https://claude.ai/chat/mock-chat',
    html: CLAUDE_HTML,
    composerKind: 'contenteditable',
    hooks: {
      composer: '#claude-composer',
      send: 'button[aria-label="Send Message"]',
      stop: 'button[aria-label="Stop response"]',
      newChat: 'button[aria-label="Start new chat"]',
      messages: '#conversation',
      loginWall: '.login-required',
      fileInput: '.file-upload',
    },
    assistantBubble: '<div class="font-claude-message"><div class="markdown">{{{text}}}</div></div>',
    userBubble: '<div class="font-user-message">{{{text}}}</div>',
  },
  gemini: {
    provider: 'gemini',
    url: 'https://gemini.google.com/app/mock',
    html: GEMINI_HTML,
    composerKind: 'contenteditable',
    hooks: {
      composer: 'rich-textarea .ql-editor',
      send: 'button.send-button',
      stop: 'button.stop-button',
      newChat: 'button.new-chat-button',
      messages: '#conversation-container',
      loginWall: '.sign-in-wall',
      fileInput: 'input.file-input',
      attach: '.upload-button',
    },
    assistantBubble:
      '<model-response class="model-response"><message-content><div class="markdown">{{{text}}}</div></message-content></model-response>',
    userBubble: '<user-query><div class="query-text">{{{text}}}</div></user-query>',
  },
  grok: {
    provider: 'grok',
    url: 'https://grok.com/chat/mock',
    html: GROK_HTML,
    composerKind: 'textarea',
    hooks: {
      composer: '#query-input',
      send: 'button.submit-button',
      stop: 'button.stop-button',
      newChat: 'button.new-chat-button',
      messages: '#chat-messages',
      loginWall: '#login-wall',
      fileInput: 'input.file-input',
    },
    assistantBubble:
      '<div class="message-bubble assistant"><div class="response-content-markdown">{{{text}}}</div></div>',
    userBubble: '<div class="message-bubble user"><div class="query-text">{{{text}}}</div></div>',
  },
};

/** `https://chatgpt.com/*` style patterns for each fixture. */
export const SITE_MATCH_PATTERNS: Record<string, string[]> = {
  mock: ['https://mock.browsermind.local/*'],
  deepseek: ['https://chat.deepseek.com/*'],
  chatgpt: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  claude: ['https://claude.ai/*'],
  gemini: ['https://gemini.google.com/*'],
  grok: ['https://grok.com/*', 'https://x.com/i/grok*'],
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Split a reply into streaming chunks the way a real provider does. */
export function chunkText(text: string, chunks = 12): string[] {
  const words = text.split(/(\s+)/);
  const perChunk = Math.max(1, Math.ceil(words.length / chunks));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += perChunk) {
    out.push(words.slice(i, i + perChunk).join(''));
  }
  return out.length ? out : [text];
}

export function defaultReplyText(provider: string, message: string): string {
  return (
    `[${provider}] I received your message: "${message}". ` +
    `Here is how BrowserMind handled it: the runtime matched a plugin, the plugin drove the page composer, ` +
    `the streaming detector watched the answer bubble and the worker returned this complete reply.`
  );
}
