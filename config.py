import os
import sys
from dotenv import load_dotenv

load_dotenv()

# Reddit API credentials
REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET")
REDDIT_USERNAME = os.getenv("REDDIT_USERNAME")
REDDIT_PASSWORD = os.getenv("REDDIT_PASSWORD")
REDDIT_USER_AGENT = os.getenv("REDDIT_USER_AGENT", "llmphysics-bot/0.1 by u/YourBotAccount")

_REQUIRED = {
    "REDDIT_CLIENT_ID": REDDIT_CLIENT_ID,
    "REDDIT_CLIENT_SECRET": REDDIT_CLIENT_SECRET,
    "REDDIT_USERNAME": REDDIT_USERNAME,
    "REDDIT_PASSWORD": REDDIT_PASSWORD,
}
_missing = [k for k, v in _REQUIRED.items() if not v]
if _missing:
    sys.exit(f"Missing required environment variables: {', '.join(_missing)}")

# Subreddit to monitor
SUBREDDIT = os.getenv("SUBREDDIT", "LLMPhysics")

# Bot behavior
COMMAND_PREFIX = "!define"
WIKIPEDIA_LANG = "en"
WIKI_SUMMARY_SENTENCES = 3
