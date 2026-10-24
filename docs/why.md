# Why Daily YouTube Digest

## Why I started

There are far more YouTube videos I want to watch than time to watch them. So the plan is to read a summary first, and only then go and watch the videos that actually look interesting.

## How I use it

Channels are picked once. Every day the pipeline scrapes the new videos from those channels and sends the digest to Notion, where I read a one-to-three-paragraph summary of each video. From there I either discuss the summary with an AI (ask further questions, argue about it) or go watch the full video.

Watching the video matters when the content is inherently visual. For technical material — a technique that works, a concept, a general trend — reading the summary is enough.

## Decisions

- **Gemini first.** It was free and worked well. I want to try other models too.
- **GitHub Actions, not a local machine.** Everything runs in the cloud, so neither my computer nor a local drive has to be on. That is one of the best parts of the setup.
- **Keys as GitHub Actions secrets.** The Notion token and the model API key live there; no key is kept on a machine.
- **Notion as the destination.** The digest lands directly in my own notes, which makes it easy to read.

## The part I still have to fix

The digest only pays off if reading it becomes a daily habit. My morning routine is English study, then the digest. When I go to bed late and wake up late, I skip it. That is something I have to fix myself.
