import { Devvit } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  http: true,
});

const COMMAND_PREFIX = '!define';
const WIKI_PAGE = 'mod-digest';
const BLANK_CONTENT = '_No entries this week._';
const DIGEST_JOB = 'mod_digest';

// ---------------------------------------------------------------------------
// !define <term> — reply with a Wikipedia summary
// ---------------------------------------------------------------------------
Devvit.addTrigger({
  event: 'CommentSubmit',
  onEvent: async (event, context) => {
    if (!event.comment) return;

    const body = event.comment.body.trim();
    if (!body.toLowerCase().startsWith(COMMAND_PREFIX)) return;

    const term = body.slice(COMMAND_PREFIX.length).trim();
    if (!term) return;

    let replyText: string;

    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`;
      const res = await fetch(url);

      if (!res.ok) {
        replyText = `No Wikipedia article found for "${term}".`;
      } else {
        const data = (await res.json()) as {
          title: string;
          extract: string;
          content_urls: { desktop: { page: string } };
        };
        replyText =
          `**${data.title}**\n\n${data.extract}\n\n` +
          `[Read more](${data.content_urls.desktop.page})\n\n` +
          `---\n^(I'm a bot for r/LLMPhysics. Use \`!define <term>\` to look up a physics concept.)`;
      }
    } catch (e) {
      console.error(`define: fetch failed for "${term}": ${e}`);
      replyText = `Sorry, I couldn't reach Wikipedia right now. Try again in a moment.`;
    }

    await context.reddit.submitComment({
      id: event.comment.id,
      text: replyText,
    });
  },
});

// ---------------------------------------------------------------------------
// Weekly mod digest — reads wiki page, posts, distinguishes, stickies, clears
// ---------------------------------------------------------------------------
Devvit.addSchedulerJob({
  name: DIGEST_JOB,
  onRun: async (_, context) => {
    const subreddit = await context.reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;

    // Read wiki page
    let content: string;
    try {
      const page = await context.reddit.getWikiPage(subredditName, WIKI_PAGE);
      content = page.content.trim();
    } catch (e) {
      console.error(`mod_digest: could not read wiki page "${WIKI_PAGE}": ${e}`);
      return;
    }

    if (!content || content === BLANK_CONTENT) {
      console.log('mod_digest: wiki page empty — skipping this week');
      return;
    }

    // Submit the post
    let postId: string;
    try {
      const post = await context.reddit.submitPost({
        subredditName,
        title: 'Weekly Mod Digest',
        text: content,
      });
      postId = post.id;
      console.log(`mod_digest: submitted post ${postId}`);
    } catch (e) {
      console.error(`mod_digest: failed to submit post: ${e}`);
      return;
    }

    // Distinguish as mod + sticky
    try {
      await context.reddit.distinguish(postId, true);  // true = moderator distinguish
      await context.reddit.sticky(postId, true);
    } catch (e) {
      // Post is up — log and continue rather than bailing entirely
      console.error(`mod_digest: post submitted but mod actions failed: ${e}`);
    }

    // Reset wiki page for next week
    try {
      await context.reddit.updateWikiPage({
        subredditName,
        page: WIKI_PAGE,
        content: BLANK_CONTENT,
        reason: 'bot: cleared after weekly digest post',
      });
      console.log('mod_digest: wiki page reset for next week');
    } catch (e) {
      console.error(`mod_digest: could not reset wiki page: ${e}`);
    }
  },
});

// ---------------------------------------------------------------------------
// On install — schedule the weekly digest job (Sunday midnight UTC)
// ---------------------------------------------------------------------------
Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_, context) => {
    await context.scheduler.runJob({
      name: DIGEST_JOB,
      cron: '0 0 * * 0', // minute hour day month weekday — every Sunday 00:00 UTC
    });
    console.log('mod_digest job scheduled: every Sunday 00:00 UTC');
  },
});

export default Devvit;
