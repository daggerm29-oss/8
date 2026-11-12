#!/bin/sh
# Delegate a cgroup v2 subtree to an unprivileged user, the way systemd does for user@<uid>.service (Delegate=yes),
# and move a process into it so the Helix Engine it starts can create per-sandbox cgroups (R1.8, F-SBX-5, §16.4).
# Usage (as root): cgroup-delegate.sh <uid> <pid>
# Hosts whose Engine already runs in a delegated systemd user slice do not need this.
# If the root cgroup is in threaded mode (some VMs), the subtree is threaded too: cpu and pids only, no memory.
set -eu
uid="$1"
pid="$2"
root=/sys/fs/cgroup
[ -f "$root/cgroup.controllers" ] || { echo "cgroup v2 is not mounted at $root" >&2; exit 1; }
base="$root/helix-$uid"
mkdir -p "$base"
for c in cpu memory pids; do
  grep -qw "$c" "$root/cgroup.controllers" && { echo "+$c" > "$root/cgroup.subtree_control" 2>/dev/null || true; }
done
if [ "$(cat "$root/cgroup.type")" = "domain threaded" ] && [ "$(cat "$base/cgroup.type")" != "threaded" ]; then
  echo threaded > "$base/cgroup.type"
fi
chown "$uid" "$base" "$base/cgroup.procs" "$base/cgroup.threads" "$base/cgroup.subtree_control" "$base/cgroup.type"
if [ "$(cat "$base/cgroup.type")" = "threaded" ]; then
  for t in /proc/"$pid"/task/*; do echo "${t##*/}" > "$base/cgroup.threads"; done
else
  echo "$pid" > "$base/cgroup.procs"
fi
echo "delegated $base ($(cat "$base/cgroup.type"); controllers: $(cat "$base/cgroup.controllers")) to uid $uid, pid $pid"
