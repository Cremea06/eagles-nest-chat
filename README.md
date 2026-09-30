# Eagles Nest Chat

AI-monitored public chat for afirstflag.com.

Live: https://chat.afirstflag.com  
Site repo: https://github.com/Cremea06/afirstflag

## Current help wanted

Open-tier chat commands — [Issue #1](https://github.com/Cremea06/eagles-nest-chat/issues/1).

Command tiers and rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Run locally

```bash
cp .env.example .env   # add keys locally; never commit .env
npm install
npm start
```

## last5.txt (public room tail)

`https://chat.afirstflag.com/last5.txt` is **world-readable on purpose**. It holds only
the last 5 lines already broadcast to the public Milliway room (people and Neagle), one per
line as `username: text`, rewritten on every public message. It is a tail, not a log
archive: nothing older than 5 lines is kept, it starts empty on every server restart, and it
never contains commands, login/register/auth traffic, private-pane text, system notices,
presence events, or Nest World (`/nest`) traffic.

The file lives at `data/last5.txt` (gitignored; override with `LAST5_PATH`). The node
process must be able to create and write that directory.
