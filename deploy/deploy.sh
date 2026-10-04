#!/usr/bin/env bash
# Ship the committed code to the always-on host, build the web board, restart the service.
#   deploy/deploy.sh            # host alias "station" (Proxmox VM claude-station)
#   DEPLOY_HOST=other deploy/deploy.sh
# Personal files (config/profile.yaml, CV, secrets) are not in git; copy them once by hand.
set -euo pipefail

HOST=${DEPLOY_HOST:-station}
DIR='~/Hellkitchen/solution/job-hunter'
cd "$(dirname "$0")/.."

if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo "Uncommitted changes — commit first, deploy ships HEAD only." >&2
  exit 1
fi

git push -q "$HOST" HEAD:refs/heads/main
ssh "$HOST" bash -lc "'
  set -e
  cd $DIR
  git fetch -q origin && git reset -q --hard origin/main
  mise exec -- npm ci --no-audit --no-fund --silent
  mise exec -- npm run build --silent >/dev/null
  mise exec -- npm test 2>&1 | grep -E \"^ℹ (pass|fail)\"
  mkdir -p ~/.config/systemd/user
  ln -sf \"\$PWD/deploy/systemd/job-hunter.service\" ~/.config/systemd/user/job-hunter.service
  systemctl --user daemon-reload
  systemctl --user enable -q job-hunter
  systemctl --user restart job-hunter
  sleep 4
  systemctl --user is-active job-hunter
  git log --oneline -1
'"
