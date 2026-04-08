# b17: 7922L
import logging
import time

import praw

import config
from plugins.physics_define import lookup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


def make_reddit() -> praw.Reddit:
    return praw.Reddit(
        client_id=config.REDDIT_CLIENT_ID,
        client_secret=config.REDDIT_CLIENT_SECRET,
        username=config.REDDIT_USERNAME,
        password=config.REDDIT_PASSWORD,
        user_agent=config.REDDIT_USER_AGENT,
    )


def handle_comment(comment: praw.models.Comment) -> None:
    body = comment.body.strip()
    if not body.lower().startswith(config.COMMAND_PREFIX):
        return

    term = body[len(config.COMMAND_PREFIX):].strip()
    if not term:
        return

    log.info("Defining: %s (comment %s)", term, comment.id)
    reply = lookup(term, sentences=config.WIKI_SUMMARY_SENTENCES)

    footer = (
        "\n\n---\n"
        "^(I'm a bot for r/LLMPhysics. "
        "Use `!define <term>` to look up a physics concept.)"
    )
    comment.reply(reply + footer)
    log.info("Replied to %s", comment.id)


def run() -> None:
    reddit = make_reddit()
    subreddit = reddit.subreddit(config.SUBREDDIT)
    log.info("Watching r/%s for '%s' commands...", config.SUBREDDIT, config.COMMAND_PREFIX)

    while True:
        try:
            for comment in subreddit.stream.comments(skip_existing=True):
                handle_comment(comment)
        except Exception as exc:
            log.error("Stream error: %s — restarting in 60s", exc)
            time.sleep(60)


if __name__ == "__main__":
    run()
