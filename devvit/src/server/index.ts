import { Hono } from 'hono';
import { reddit } from '@devvit/reddit';
import { redis } from '@devvit/redis';
import { context, settings, scheduler } from '@devvit/web/server';
import type {
  OnCommentSubmitRequest,
  OnAppInstallRequest,
  OnAppUpgradeRequest,
  TriggerResponse,
  SettingsValidationRequest,
  SettingsValidationResponse,
} from '@devvit/web/shared';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';

const app = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COMMAND = '!define';
const BLANK_DIGEST = '_No entries this week._';
const DIGEST_JOB_ID_KEY = 'bot:digest:jobId';
const DIGEST_CRON_KEY = 'bot:digest:cron';

// Reply message templates — edit these in code if you want to change them.
// Full mod-configurable settings are in devvit.json / the Install Settings UI.
const REPLY_FOOTER =
  "^(I'm a bot for r/LLMPhysics. Use `!define <term>` to look up a physics concept.)";
const REPLY_NOT_FOUND = 'No Wikipedia article found for "{term}".';
const REPLY_OFF_TOPIC =
  'Sorry, "{term}" doesn\'t look like a science topic I cover.';
const REPLY_ERROR =
  "Sorry, I couldn't reach Wikipedia right now. Try again in a moment.";

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
async function getBotUsername(): Promise<string> {
  const val = await settings.get<string>('botUsername');
  return (val ?? 'llmphysics-bot').toLowerCase();
}

async function getAllowedKeywords(): Promise<string[]> {
  const val = await settings.get<string>('allowedCategoryKeywords');
  return (val ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
}

async function getBlockedTerms(): Promise<string[]> {
  const val = await settings.get<string>('blockedTerms');
  return (val ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

async function getDigestCron(): Promise<string> {
  const val = await settings.get<string>('digestCron');
  return val ?? '0 0 * * 0';
}

async function getDigestWikiPage(): Promise<string> {
  const val = await settings.get<string>('digestWikiPage');
  return val ?? 'mod-digest';
}

async function getDigestPostTitle(): Promise<string> {
  const val = await settings.get<string>('digestPostTitle');
  return val ?? 'Weekly Mod Digest';
}

async function getSummarySentences(): Promise<number> {
  const val = await settings.get<number>('summarySentences');
  return val ?? 3;
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTerm(afterCommand: string): string | null {
  const match = afterCommand.match(/^[^\n.?]*/);
  if (!match) return null;
  const term = match[0]
    .replace(/^[\s!,;:]+/, '')
    .replace(/[\s!,;:]+$/, '')
    .trim();
  return term || null;
}

function parseCommand(
  body: string,
  botUsername: string,
): { term: string; mode: 'prefix' | 'summon' } | null {
  const trimmed = body.trim();
  const trimmedLower = trimmed.toLowerCase();
  const commandLower = COMMAND.toLowerCase();

  // Prefix mode: comment starts with !define
  if (trimmedLower.startsWith(commandLower)) {
    const term = extractTerm(trimmed.slice(COMMAND.length));
    if (term) return { term, mode: 'prefix' };
    return null;
  }

  // Summon mode: comment mentions u/<bot> and contains !define
  const mentionPattern = new RegExp(`\\bu/${escapeRegex(botUsername)}\\b`, 'i');
  if (!mentionPattern.test(body)) return null;

  const defineIdx = body.toLowerCase().indexOf(commandLower);
  if (defineIdx === -1) return null;

  const term = extractTerm(body.slice(defineIdx + COMMAND.length));
  if (term) return { term, mode: 'summon' };
  return null;
}

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------
interface WikiSummary {
  title: string;
  extract: string;
  content_urls: { desktop: { page: string } };
}

async function fetchSummary(term: string): Promise<WikiSummary | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`wikipedia: summary lookup for "${term}" returned ${res.status}`);
    return null;
  }
  return (await res.json()) as WikiSummary;
}

async function lookupTerm(term: string): Promise<WikiSummary | null> {
  const direct = await fetchSummary(term);
  if (direct) return direct;

  const firstWord = term.split(/\s+/)[0] ?? '';
  if (firstWord && firstWord !== term) {
    console.log(`define: "${term}" not found, falling back to "${firstWord}"`);
    return await fetchSummary(firstWord);
  }
  return null;
}

async function fetchCategories(title: string): Promise<string[]> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&format=json` +
    `&prop=categories&cllimit=max&clshow=!hidden` +
    `&titles=${encodeURIComponent(title)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`wikipedia: categories lookup for "${title}" returned ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    query?: {
      pages?: Record<string, { categories?: { title: string }[] }>;
    };
  };
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  if (pages.length === 0) return [];
  const cats = pages[0].categories ?? [];
  return cats.map((c) => c.title.replace(/^Category:/, '').toLowerCase());
}

function isAllowedTopic(categories: string[], keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  return categories.some((cat) => keywords.some((kw) => cat.includes(kw)));
}

function renderTemplate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function firstSentences(text: string, n: number): string {
  const parts = text.split('. ');
  const slice = parts.slice(0, Math.max(1, n)).join('. ');
  return slice.endsWith('.') ? slice : slice + '.';
}

// ---------------------------------------------------------------------------
// Scheduler management
// ---------------------------------------------------------------------------
async function ensureDigestScheduled(): Promise<void> {
  const desired = await getDigestCron();
  const current = await redis.get(DIGEST_CRON_KEY);

  if (current === desired) {
    console.log(`digest: cron already in sync ("${desired}"), no reschedule`);
    return;
  }

  const existingId = await redis.get(DIGEST_JOB_ID_KEY);
  if (existingId) {
    try {
      await scheduler.cancelJob(existingId);
      console.log(`digest: cancelled old job ${existingId} (was cron="${current ?? '?'}")`);
    } catch (e) {
      console.error(`digest: could not cancel old job ${existingId}: ${e}`);
    }
  }

  try {
    const jobId = await scheduler.runJob({
      name: 'mod-digest',
      cron: desired,
    });
    await redis.set(DIGEST_JOB_ID_KEY, jobId);
    await redis.set(DIGEST_CRON_KEY, desired);
    console.log(`digest: scheduled with cron "${desired}" (jobId=${jobId})`);
  } catch (e) {
    console.error(`digest: failed to schedule with cron "${desired}": ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Trigger: onCommentSubmit
// ---------------------------------------------------------------------------
app.post('/internal/triggers/on-comment-submit', async (c) => {
  const input = await c.req.json<OnCommentSubmitRequest>();
  const comment = input.comment;
  const author = input.author;

  if (!comment?.body) return c.json<TriggerResponse>({ status: 'ok' });

  const body = comment.body;
  const bodyLower = body.toLowerCase();

  // Fast path: skip if !define not present at all
  if (!bodyLower.includes(COMMAND.toLowerCase())) {
    return c.json<TriggerResponse>({ status: 'ok' });
  }

  const botUsername = await getBotUsername();

  // Skip the bot's own comments
  if (author?.name?.toLowerCase() === botUsername) {
    console.log(`define: ignoring own comment ${comment.id}`);
    return c.json<TriggerResponse>({ status: 'ok' });
  }

  const parsed = parseCommand(body, botUsername);
  if (!parsed) {
    console.log(
      `define: comment ${comment.id} contains "${COMMAND}" but no valid invocation; skipping`,
    );
    return c.json<TriggerResponse>({ status: 'ok' });
  }

  const { term, mode } = parsed;
  console.log(`define: mode=${mode} term="${term}" comment=${comment.id} author=${author?.name ?? '?'}`);

  const footer = '\n\n---\n' + REPLY_FOOTER;
  const termLower = term.toLowerCase();
  const blockedTerms = await getBlockedTerms();
  const allowedKeywords = await getAllowedKeywords();
  const summarySentences = await getSummarySentences();

  // Blocklist check
  if (
    blockedTerms.length > 0 &&
    blockedTerms.some((b) => termLower === b || termLower.includes(b))
  ) {
    console.log(`define: "${term}" matched blocklist; rejecting`);
    await replyWith(
      comment.id,
      renderTemplate(REPLY_OFF_TOPIC, { term }) + footer,
    );
    return c.json<TriggerResponse>({ status: 'ok' });
  }

  let replyText: string;
  try {
    const summary = await lookupTerm(term);
    if (!summary) {
      console.log(`define: no Wikipedia article for "${term}"`);
      replyText = renderTemplate(REPLY_NOT_FOUND, { term }) + footer;
    } else {
      const cats = await fetchCategories(summary.title);
      if (!isAllowedTopic(cats, allowedKeywords)) {
        const preview = cats.slice(0, 8).join(', ') + (cats.length > 8 ? ', ...' : '');
        console.log(`define: "${summary.title}" rejected as off-topic; categories=[${preview}]`);
        replyText = renderTemplate(REPLY_OFF_TOPIC, { term }) + footer;
      } else {
        console.log(`define: "${summary.title}" accepted (${cats.length} categories)`);
        const extract = firstSentences(summary.extract, summarySentences);
        replyText =
          `**${summary.title}**\n\n${extract}\n\n` +
          `[Read more](${summary.content_urls.desktop.page})` +
          footer;
      }
    }
  } catch (e) {
    console.error(`define: lookup failed for "${term}": ${e}`);
    replyText = REPLY_ERROR + footer;
  }

  await replyWith(comment.id, replyText);
  return c.json<TriggerResponse>({ status: 'ok' });
});

async function replyWith(commentId: string, text: string): Promise<void> {
  // submitComment expects the full t1_ prefixed ID
  const fullId = commentId.startsWith('t1_') ? commentId : `t1_${commentId}`;
  try {
    await reddit.submitComment({ id: fullId as `t1_${string}`, text });
    console.log(`define: replied to ${fullId}`);
  } catch (e) {
    console.error(`define: could not submit reply to ${fullId}: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Trigger: onAppInstall
// ---------------------------------------------------------------------------
app.post('/internal/triggers/on-app-install', async (c) => {
  await c.req.json<OnAppInstallRequest>();
  console.log('llmphysics-bot: installed, scheduling jobs');
  await ensureDigestScheduled();
  return c.json<TriggerResponse>({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Trigger: onAppUpgrade
// ---------------------------------------------------------------------------
app.post('/internal/triggers/on-app-upgrade', async (c) => {
  await c.req.json<OnAppUpgradeRequest>();
  console.log('llmphysics-bot: upgraded, re-syncing jobs');
  // Clear stored job ID so ensureDigestScheduled re-creates cleanly
  try {
    await redis.del(DIGEST_JOB_ID_KEY);
  } catch {
    /* non-fatal */
  }
  await ensureDigestScheduled();
  return c.json<TriggerResponse>({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Scheduler: heartbeat (every 5 minutes)
// Re-syncs digest schedule in case settings changed
// ---------------------------------------------------------------------------
app.post('/internal/scheduler/heartbeat', async (c) => {
  await c.req.json<TaskRequest>();
  console.log('heartbeat: running config sync');
  try {
    await ensureDigestScheduled();
  } catch (e) {
    console.error(`heartbeat: failed: ${e}`);
  }
  return c.json<TaskResponse>({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Scheduler: mod-digest
// ---------------------------------------------------------------------------
app.post('/internal/scheduler/mod-digest', async (c) => {
  await c.req.json<TaskRequest>();

  const { subredditName } = context;
  if (!subredditName) {
    console.error('digest: no subredditName in context');
    return c.json<TaskResponse>({ status: 'ok' });
  }

  const page = await getDigestWikiPage();
  console.log(`digest: firing; reading wiki page "${page}" on r/${subredditName}`);

  let content: string;
  try {
    const wiki = await reddit.getWikiPage(subredditName, page);
    content = wiki.content.trim();
  } catch (e) {
    console.error(`digest: could not read wiki page "${page}": ${e}`);
    return c.json<TaskResponse>({ status: 'ok' });
  }

  if (!content) {
    console.warn(`digest: wiki page "${page}" is empty — nothing to post this week`);
    return c.json<TaskResponse>({ status: 'ok' });
  }
  if (content === BLANK_DIGEST) {
    console.warn(`digest: wiki page "${page}" still holds the blank placeholder — skipping`);
    return c.json<TaskResponse>({ status: 'ok' });
  }

  const title = await getDigestPostTitle();
  let postId: string;
  try {
    const post = await reddit.submitPost({
      subredditName,
      title,
      text: content,
    });
    postId = post.id;
    console.log(`digest: submitted post ${postId} titled "${title}"`);
  } catch (e) {
    console.error(`digest: failed to submit post: ${e}`);
    return c.json<TaskResponse>({ status: 'ok' });
  }

  try {
    const post = await reddit.getPostById(postId as `t3_${string}`);
    await post.distinguish();
    await post.sticky(1);
    console.log(`digest: distinguished and stickied ${postId}`);
  } catch (e) {
    console.error(`digest: post ${postId} submitted but mod actions failed: ${e}`);
  }

  try {
    await reddit.updateWikiPage({
      subredditName,
      page,
      content: BLANK_DIGEST,
      reason: 'bot: cleared after weekly digest post',
    });
    console.log(`digest: wiki page "${page}" reset for next week`);
  } catch (e) {
    console.error(`digest: could not reset wiki page: ${e}`);
  }

  return c.json<TaskResponse>({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Settings validation: cron expression
// ---------------------------------------------------------------------------
app.post('/internal/settings/validate-cron', async (c) => {
  const { value } = await c.req.json<SettingsValidationRequest<string>>();

  if (!value || typeof value !== 'string' || value.trim() === '') {
    return c.json<SettingsValidationResponse>({
      success: false,
      error: 'Cron expression cannot be empty',
    });
  }

  // Standard 5-part cron: min hour dom month dow
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) {
    return c.json<SettingsValidationResponse>({
      success: false,
      error: 'Cron expression must have exactly 5 parts: minute hour day-of-month month day-of-week',
    });
  }

  // Validate each field with a permissive but reasonable pattern
  // Allows: numbers, ranges (1-5), steps (*/2), lists (1,2,3), wildcards (*)
  const cronFieldPattern = /^(\*|(\d+(-\d+)?))(\/\d+)?(,(\*|(\d+(-\d+)?))(\/\d+)?)*$/;
  const fieldNames = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  const fieldRanges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!cronFieldPattern.test(part)) {
      return c.json<SettingsValidationResponse>({
        success: false,
        error: `Invalid value "${part}" for ${fieldNames[i]} field`,
      });
    }
    // Check numeric values are in range
    const nums = part.match(/\d+/g);
    if (nums) {
      const [min, max] = fieldRanges[i];
      for (const num of nums) {
        const n = parseInt(num, 10);
        if (n < min || n > max) {
          return c.json<SettingsValidationResponse>({
            success: false,
            error: `Value ${n} is out of range for ${fieldNames[i]} field (${min}–${max})`,
          });
        }
      }
    }
  }

  return c.json<SettingsValidationResponse>({ success: true });
});

// ---------------------------------------------------------------------------
// Settings validation: summary sentences
// ---------------------------------------------------------------------------
app.post('/internal/settings/validate-sentences', async (c) => {
  const { value } = await c.req.json<SettingsValidationRequest<number>>();

  if (value === undefined || value === null) {
    return c.json<SettingsValidationResponse>({
      success: false,
      error: 'Please enter a number',
    });
  }
  if (!Number.isInteger(value) || value < 1) {
    return c.json<SettingsValidationResponse>({
      success: false,
      error: 'Must be a whole number of at least 1',
    });
  }
  if (value > 10) {
    return c.json<SettingsValidationResponse>({
      success: false,
      error: 'Maximum is 10 sentences to keep replies readable',
    });
  }

  return c.json<SettingsValidationResponse>({ success: true });
});

export default app;
