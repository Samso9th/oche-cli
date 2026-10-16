# oche-cli

`oche` from your terminal. It talks to your Oche server with a token you create in the dashboard under Settings → CLI tokens. Self-hosting? Run `oche login https://your-server` once.

```sh
npm install -g oche-cli    # installs the `oche` command

oche login                  # paste a CLI token from ship.oche.io/settings
oche ship                   # commit what's changed, push, then feature → dev → staging → main
oche ship staging           # stop at staging
oche ship prod --direct     # dev → main, then Oche syncs staging
oche commit -a              # AI commit message for your changes, then commit
oche status                 # repo inferred from the git remote
oche promote staging        # dev → staging
oche promote prod           # staging → main (asks first)
oche promote prod --direct  # dev → main, then Oche syncs staging
oche mode strict --approvals 2
oche onboard                # shows the plan, then sets the repo up
oche log -n 20
oche repos
```

`oche ship` shows everything it's about to do (the commit message, the files, each merge) and asks once. Answer `e` to edit the message or `r` to have it rewritten. It stops at the first step that can't finish (a review in strict mode, or a conflict); run it again once that's sorted.

Commit messages are written by your Oche server with the model it's configured for (OpenRouter), so the CLI needs no AI key. Your staged diff goes to your server and on to OpenRouter. Pass `-m "message"` to skip AI.

## Deployments: Coolify from the terminal

When the repo is linked to a Coolify instance, these read and drive it through your Oche server, which holds the Coolify token.

```sh
oche logs --stage prod            # the running container's log: why it's crash-looping
oche logs --stage prod --failures # just the errors and the tail
oche logs --app api --build       # the build log of the latest deployment instead
oche deployments                  # recent deployments per app: status, commit, how long, when
oche envs                         # which stages define each variable (names only)
oche envs --stage prod --key DATABASE_URL
oche deploy --stage staging       # redeploy (--force rebuilds without the cache); asks first
oche rollback --app api           # the images Coolify can go back to
oche rollback --app api --to a1b2c3d
oche explain --stage prod         # ask your server's AI what broke the last failed deployment
oche preflight --to prod          # missing variables, and whether staging is healthy
```

Each one picks the app with `--app <name>` (or the start of its uuid) or `--stage prod|staging|dev`; with one app it needs neither, and with several it says which ones there are. `oche deploy` and `oche rollback` ask before they act unless you pass `-y`.

`oche envs` never prints values. The server compares names, and whether staging and production hold the same value, and sends only that. Log lines Coolify marks as holding secrets are left out too.

## Without a server: `oche pr`

`oche pr` works from your machine alone. It talks to OpenRouter for the commit message and to GitHub with your own token, so it needs no Oche login.

```sh
oche ai-key                       # save an OpenRouter key once (or set OPENROUTER_API_KEY)
oche pr                           # commit everything, push this branch, open a PR into dev
oche pr --merge                   # …and merge it (merge commit; --squash or --rebase to change)
oche pr --merge -d                # …and delete the work branch on GitHub afterwards
oche pr --base develop --draft    # pick the base yourself, open as a draft
```

It refuses to run on `main`, `master`, `staging`, `dev` or `develop`. The base defaults to `dev`, or `develop` when there's no `dev` on GitHub. A branch that isn't on GitHub yet is published. If a PR from the branch is already open, it pushes to that PR instead of opening another. The GitHub token comes from `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`. `OCHE_AI_MODEL` overrides the model (default `anthropic/claude-haiku-4.5`; set another with `oche ai-key --model <id>`).

Read commands take `--json`. `OCHE_URL` and `OCHE_TOKEN` override the saved config.
