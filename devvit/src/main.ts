import { Devvit, Context } from '@devvit/public-api';
import { load as parseYaml } from 'js-yaml';

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true,
});

const COMMAND_PREFIX = '!define';
const CONFIG_WIKI_PAGE = 'mod/llmphysics-bot/config';
const DIGEST_JOB = 'mod_digest';
const BLANK_DIGEST = '_No entries this week._';

// Redis keys
const CONFIG_CACHE_KEY = 'bot:config';
const CONFIG_CACHE_SECONDS = 60;
const DIGEST_JOB_ID_KEY = 'bot:digest:jobId';
const DIGEST_CRON_KEY = 'bot:digest:cron';

// ---------------------------------------------------------------------------
// Config schema + defaults
// ---------------------------------------------------------------------------
interface BotConfig {
  allowed_category_keywords: string[];
  blocked_terms: string[];
  mod_digest: {
    wiki_page: string;
    cron: string;
    post_title: string;
  };
  reply: {
    summary_sentences: number;
    footer: string;
    not_found_message: string;
    off_topic_message: string;
    error_message: string;
  };
}

const DEFAULT_CONFIG: BotConfig = {
  allowed_category_keywords: [
    'physics',
    'mathematics',
    'chemistry',
    'astronomy',
    'astrophysics',
    'quantum',
    'relativity',
    'mechanics',
    'thermodynamics',
    'cosmology',
    'particle',
    'science',
  ],
  blocked_terms: [],
  mod_digest: {
    wiki_page: 'mod-digest',
    cron: '0 0 * * 0',
    post_title: 'Weekly Mod Digest',
  },
  reply: {
    summary_sentences: 3,
    footer:
      "^(I'm a bot for r/LLMPhysics. Use `!define <term>` to look up a physics concept.)",
    not_found_message: 'No Wikipedia article found for "{term}".',
    off_topic_message:
      'Sorry, "{term}" doesn\'t look like a science topic I cover.',
    error_message:
      "Sorry, I couldn't reach Wikipedia right now. Try again in a moment.",
  },
};

function mergeConfig(base: BotConfig, over: Partial<BotConfig>): BotConfig {
  const blocked = over.blocked_terms ?? base.blocked_terms;
  return {
    allowed_category_keywords:
      over.allowed_category_keywords ?? base.allowed_category_keywords,
    blocked_terms: blocked.map((t) => String(t).toLowerCase()),
    mod_digest: { ...base.mod_digest, ...(over.mod_digest ?? {}) },
    reply: { ...base.reply, ...(over.reply ?? {}) },
  };
}

// Reddit wiki pages render markdown in the browser, which turns YAML `#`
// comments into giant headers. Mods are expected to wrap the YAML in a
// ```yaml ... ``` fenced code block for clean rendering. This strips that
// fence before parsing so both fenced and unfenced configs work.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:ya?ml)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1] : trimmed;
}

// ---------------------------------------------------------------------------
// Config loading (Redis cache, 60s TTL)
// ---------------------------------------------------------------------------
async function loadConfig(context: Context): Promise<BotConfig> {
  const cached = await context.redis.get(CONFIG_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as BotConfig;
    } catch {
      // fall through and reload
    }
  }

  const subreddit = await context.reddit.getCurrentSubreddit();
  let config = DEFAULT_CONFIG;

  try {
    const page = await context.reddit.getWikiPage(
      subreddit.name,
      CONFIG_WIKI_PAGE,
    );
    const raw = stripCodeFence(page.content);
    const parsed = parseYaml(raw) as Partial<BotConfig> | null;
    if (parsed && typeof parsed === 'object') {
      config = mergeConfig(DEFAULT_CONFIG, parsed);
    }
  } catch (e) {
    console.log(
      `config: no valid wiki page at "${CONFIG_WIKI_PAGE}", using defaults (${e})`,
    );
  }

  try {
    await context.redis.set(CONFIG_CACHE_KEY, JSON.stringify(config));
    await context.redis.expire(CONFIG_CACHE_KEY, CONFIG_CACHE_SECONDS);
  } catch {
    // cache write failure is non-fatal
  }

  return config;
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
  if (!res.ok) return null;
  return (await res.json()) as WikiSummary;
}

async function fetchCategories(title: string): Promise<string[]> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&format=json` +
    `&prop=categories&cllimit=max&clshow=!hidden` +
    `&titles=${encodeURIComponent(title)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
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

function isAllowedTopic(categories: string[], config: BotConfig): boolean {
  if (config.allowed_category_keywords.length === 0) return true;
  const keywords = config.allowed_category_keywords.map((k) => k.toLowerCase());
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
// Scheduler: keep the digest job cron in sync with config
// ---------------------------------------------------------------------------
async function ensureDigestScheduled(
  context: Context,
  config: BotConfig,
): Promise<void> {
  const desired = config.mod_digest.cron;
  const current = await context.redis.get(DIGEST_CRON_KEY);
  if (current === desired) return;

  const existingId = await context.redis.get(DIGEST_JOB_ID_KEY);
  if (existingId) {
    try {
      await context.scheduler.cancelJob(existingId);
    } catch (e) {
      console.error(`could not cancel old digest job ${existingId}: ${e}`);
    }
  }

  const jobId = await context.scheduler.runJob({
    name: DIGEST_JOB,
    cron: desired,
  });

  await context.redis.set(DIGEST_JOB_ID_KEY, jobId);
  await context.redis.set(DIGEST_CRON_KEY, desired);
  console.log(`digest job scheduled: cron="${desired}" jobId=${jobId}`);
}

// ---------------------------------------------------------------------------
// !define <term>
// ---------------------------------------------------------------------------
Devvit.addTrigger({
  event: 'CommentSubmit',
  onEvent: async (event, context) => {
    if (!event.comment) return;

    const body = event.comment.body.trim();
    if (!body.toLowerCase().startsWith(COMMAND_PREFIX)) return;

    const term = body.slice(COMMAND_PREFIX.length).trim();
    if (!term) return;

    const config = await loadConfig(context);

    // Opportunistically keep the scheduler in sync with config.mod_digest.cron
    void ensureDigestScheduled(context, config).catch((e) =>
      console.error(`ensureDigestScheduled failed: ${e}`),
    );

    const footer = '\n\n---\n' + config.reply.footer;
    const termLower = term.toLowerCase();

    // Hard blocklist check
    if (
      config.blocked_terms.length > 0 &&
      config.blocked_terms.some((b) => termLower === b || termLower.includes(b))
    ) {
      await context.reddit.submitComment({
        id: event.comment.id,
        text: renderTemplate(config.reply.off_topic_message, { term }) + footer,
      });
      return;
    }

    let replyText: string;
    try {
      const summary = await fetchSummary(term);
      if (!summary) {
        replyText =
          renderTemplate(config.reply.not_found_message, { term }) + footer;
      } else {
        const cats = await fetchCategories(summary.title);
        if (!isAllowedTopic(cats, config)) {
          replyText =
            renderTemplate(config.reply.off_topic_message, { term }) + footer;
        } else {
          const extract = firstSentences(
            summary.extract,
            config.reply.summary_sentences,
          );
          replyText =
            `**${summary.title}**\n\n${extract}\n\n` +
            `[Read more](${summary.content_urls.desktop.page})` +
            footer;
        }
      }
    } catch (e) {
      console.error(`define: failed for "${term}": ${e}`);
      replyText = config.reply.error_message + footer;
    }

    await context.reddit.submitComment({
      id: event.comment.id,
      text: replyText,
    });
  },
});

// ---------------------------------------------------------------------------
// Weekly mod digest job
// ---------------------------------------------------------------------------
Devvit.addSchedulerJob({
  name: DIGEST_JOB,
  onRun: async (_, context) => {
    const config = await loadConfig(context);
    const subreddit = await context.reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;

    let content: string;
    try {
      const page = await context.reddit.getWikiPage(
        subredditName,
        config.mod_digest.wiki_page,
      );
      content = page.content.trim();
    } catch (e) {
      console.error(
        `mod_digest: could not read wiki page "${config.mod_digest.wiki_page}": ${e}`,
      );
      return;
    }

    if (!content || content === BLANK_DIGEST) {
      console.log('mod_digest: wiki page empty — skipping this week');
      return;
    }

    let postId: string;
    try {
      const post = await context.reddit.submitPost({
        subredditName,
        title: config.mod_digest.post_title,
        text: content,
      });
      postId = post.id;
      console.log(`mod_digest: submitted post ${postId}`);
    } catch (e) {
      console.error(`mod_digest: failed to submit post: ${e}`);
      return;
    }

    try {
      await context.reddit.distinguish(postId, true);
      await context.reddit.sticky(postId, true);
    } catch (e) {
      console.error(`mod_digest: post submitted but mod actions failed: ${e}`);
    }

    try {
      await context.reddit.updateWikiPage({
        subredditName,
        page: config.mod_digest.wiki_page,
        content: BLANK_DIGEST,
        reason: 'bot: cleared after weekly digest post',
      });
      console.log('mod_digest: wiki page reset for next week');
    } catch (e) {
      console.error(`mod_digest: could not reset wiki page: ${e}`);
    }
  },
});

// ---------------------------------------------------------------------------
// On install — schedule the digest job using current config
// ---------------------------------------------------------------------------
Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_, context) => {
    const config = await loadConfig(context);
    await ensureDigestScheduled(context, config);
    console.log('llmphysics-bot installed');
  },
});

export default Devvit;
