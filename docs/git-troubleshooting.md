# Git Troubleshooting Guide

This guide covers how to resolve common issues encountered when committing and pushing changes to the repository.

## Handling a rejected push because the remote has new commits

If you see an error similar to:

```
error: failed to push some refs to 'https://github.com/…'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref.
```

it means new commits landed on the remote branch after you created your local commit. You must incorporate those remote commits before you can push.

### 1. Ensure your working tree is clean

The command `git pull --rebase` refuses to run when you have uncommitted changes and exits with:

```
error: cannot pull with rebase: You have unstaged changes.
error: Please commit or stash them.
```

Make sure everything is committed or temporarily stashed:

```bash
git status -sb                # verify the tree is clean
git add <files>               # stage any modified files
git commit                    # create a commit, if needed
# or, if you are not ready to commit yet
# git stash push --include-untracked
```

### 2. Fetch and rebase onto the latest remote branch

Use `git pull --rebase` (or manually `git fetch` followed by `git rebase`) to replay your local commits on top of the updated remote branch. This preserves a linear history.

```bash
git pull --rebase origin main
```

Resolve any conflicts that arise during the rebase. After resolving a conflict, run `git add <file>` for each resolved file and continue:

```bash
git rebase --continue
```

If you decide to abort the rebase at any time, run `git rebase --abort`.

### 3. Push the rebased commit

Once the rebase completes successfully, push your commit to the remote branch:

```bash
git push origin main
```

If you used `git stash` earlier, remember to restore your stashed changes when you are done:

```bash
git stash pop
```

Following these steps ensures your local changes incorporate the latest upstream updates and prevents push rejections.
