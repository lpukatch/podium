# Contributing

## Where this lives

Development happens on a self-hosted Forgejo instance. **GitHub is a push
mirror**, and a mirror sync is a force push — anything committed or merged on
the GitHub side is overwritten the next time upstream pushes. That is worth
knowing before you spend an afternoon on a branch.

It does not mean GitHub is a dead end:

- **Issues and discussions on GitHub are read and answered.** Open them there.
- **Pull requests on GitHub are welcome, and are landed by replaying the
  commits upstream.** Your PR will close rather than show as merged, and the
  commit that lands keeps your authorship. Say so in the PR if you would rather
  it were squashed under your name alone.

## Getting set up

```sh
npm install
npm run dev            # UI on :3456
npm run worker         # the paced loop
npm run test:run
```

Podium needs a Dispatcharr to talk to, but it starts with no credentials and
says so rather than refusing to boot — enter them in **Settings**. Leave
`PODIUM_DRY_RUN` at `true` while developing against an install you care about:
reordering a channel is a write with no undo.

`ffmpeg` on `PATH` matters for the probe tests. Without it they exercise the
parser but not the real `ffprobe` path.

## Before you open a PR

```sh
npm run format:check   # biome
npm run type-check
npm run test:run
```

CI runs exactly these three, plus a Docker build.

Commit messages are [Conventional Commits](https://www.conventionalcommits.org/)
— `feat:`, `fix:`, `chore:`, and `feat!:`/`BREAKING CHANGE:` for anything
breaking. They are not decoration: the release job reads them to decide whether
the next version is a patch, a minor or a major.

## What tends to need discussion first

Matching and ranking are where Podium's opinions live, and both have cases that
look like bugs until you know the story — a `contains` that quietly claims half a
league, an event channel that is genuinely dead an hour before kickoff, a loop
check that costs 120s per stream to catch a rare failure.
[docs/usage.md](docs/usage.md) explains the reasoning for each. If a change
contradicts one of those, open an issue
first and say what you are seeing; there is probably a real install behind the
current behaviour.
