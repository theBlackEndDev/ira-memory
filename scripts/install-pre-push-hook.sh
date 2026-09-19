#!/bin/sh
# Install scripts/pre-push-hook.sh into one or more repos' .git/hooks/pre-push.
#
#   ./scripts/install-pre-push-hook.sh                  # this repo + ~/.pi/agent/extensions
#   ./scripts/install-pre-push-hook.sh /path/to/repo ... # explicit targets
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
template="${here}/pre-push-hook.sh"
[ -f "$template" ] || { echo "missing template: $template" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  targets="$*"
else
  targets="$(CDPATH= cd -- "${here}/.." && pwd) ${HOME}/.pi/agent/extensions"
fi

for repo in $targets; do
  git_dir=$(git -C "$repo" rev-parse --git-dir 2>/dev/null) || {
    echo "skip (not a git repo): $repo" >&2
    continue
  }
  case "$git_dir" in /*) ;; *) git_dir="${repo}/${git_dir}" ;; esac
  mkdir -p "${git_dir}/hooks"
  cp "$template" "${git_dir}/hooks/pre-push"
  chmod +x "${git_dir}/hooks/pre-push"
  echo "installed: ${git_dir}/hooks/pre-push"
done
