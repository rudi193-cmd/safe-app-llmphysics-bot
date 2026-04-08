import os
from dotenv import load_dotenv

load_dotenv()

# Reddit API credentials
REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET")
REDDIT_USERNAME = os.getenv("REDDIT_USERNAME")
REDDIT_PASSWORD = os.getenv("REDDIT_PASSWORD")
REDDIT_USER_AGENT = os.getenv("REDDIT_USER_AGENT", "llmphysics-bot/0.1 by u/YourBotAccount")

# Subreddit to monitor
SUBREDDIT = os.getenv("SUBREDDIT", "LLMPhysics")

# Bot behavior
COMMAND_PREFIX = "!define"
WIKIPEDIA_LANG = "en"
WIKI_SUMMARY_SENTENCES = 3
